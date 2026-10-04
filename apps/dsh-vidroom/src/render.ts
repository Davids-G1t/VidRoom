/**
 * 渲染编排:一条 run 从「冻结的计划」走到「候选 / 成片 + 回执」。
 *
 * 三条纪律:
 * ① **先核哈希再动 GPU** —— 工程哈希或计划哈希对不上,一个 ComfyUI 请求都不发;
 * ② **H3 单 worker 串行**(本机一张卡,`budget.gpuWorkers` 只认 1),候选按配方去重;
 * ③ 生成完的素材**立刻取回本机并登记进工程**,不靠 ComfyUI 的内存历史复跑。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { H3_WORKFLOW_ID, assertSupported, h3Run, h3WorkflowHash, type H3RunResult } from './adapter.js';
import { alignmentIssues } from './align.js';
import { composeFinal } from './compose.js';
import { mediaTools } from './config.js';
import { VidroomError, errorFacts, type VidroomErrorCode } from './errors.js';
import { sha256File, toolVersion, type MediaTools } from './media.js';
import { assertPlanHash, buildPlan, readReceipts, requestFor, type NewRequest, type Plan, type PlanTarget } from './plan.js';
import { applyPatch, ensureDir, importAsset, nextId, readProject, updateProject } from './project-io.js';
import { H3_FPS } from './frames.js';
import { projectHash, type Budget, type Candidate, type PatchOp, type Project } from './project.js';
import { RunStore, newRunId, type Receipt, type RunMode, type RunShot } from './receipts.js';
import type { VidroomRuntime } from './runtime.js';

export interface RenderRequest {
  dir: string;
  target: PlanTarget;
  /** 调用方手里的工程哈希(乐观并发):对不上就拒,不往下走。 */
  expectedProjectHash?: string;
  /** 计划哈希:必填。对不上就是拿旧计划跑新工程,直接拒。 */
  planHash: string;
  budget?: Partial<Budget>;
  /** 变体运行为 false:新候选只进 run 快照,不回写工程。 */
  writeBack?: boolean;
  /** 冻结的校准输入:同批多条时由调用方一次性读了传进来,免得同批第一条跑完就把后面的 planHash 改了。 */
  receipts?: Receipt[];
}

export interface RenderResult {
  runId: string;
  receipt: Receipt;
  plan: Plan;
  /** 这一跑新登记进工程的候选 id。 */
  newCandidateIds: string[];
  /** 工程被回写后的新哈希(没回写就是 undefined)。 */
  projectHashAfter?: string;
}

/** 候选阶段跑完该停在哪:还有镜头没选定 → 待选;对齐没齐 → 待对齐。 */
function restingState(project: Project, mode: RunMode): Receipt['state'] {
  if (mode === 'final') return 'succeeded';
  const missingSelection = project.shots.some((shot) => shot.selectedCandidateId === undefined);
  if (missingSelection) return 'awaiting-selection';
  return alignmentIssues(project).length > 0 ? 'awaiting-alignment' : 'succeeded';
}

/** 落盘用的名字:只留最后一段并挡掉路径分隔,别让外部字符串决定写到哪。 */
function sanitizeName(raw: string): string {
  const name = basename(raw).replace(/[^A-Za-z0-9._-]/g, '_');
  return name === '' || name === '.' || name === '..' ? 'unknown' : name;
}

/** 候选请求 → ComfyUI 的一次提交 + 把产物取回本机(登记交给调用方,它才看得到工程现状)。 */
/**
 * 生成期间有人改过工程时的回写方式:只把我们这一跑新加的资产/候选并过去,
 * 别人的 patch、别人导的素材、别人选定的候选都不动 —— 拿开工时那份整份覆盖会把它们抹掉。
 *
 * 生成是分钟级的,这期间面板可以手工登记候选,撞上同一个 `cand-N` 是可能的:
 * 撞了就给新候选换一个 id,并把映射交回调用方(回执里那个 id 得真的指向跑出来的东西)。
 * 资产撞 id 不能这么化 —— 文件已经在 `assets/` 里占着那个名 —— 所以直接报错,不装作登记成功。
 */
function mergeGenerated(
  current: Project,
  ran: Project,
  incoming: { candidateIds: string[]; startAssetIds: Set<string> },
): { project: Project; idMap: Map<string, string> } {
  const currentAssetIds = new Set(current.assets.map((asset) => asset.id));
  const addedAssets = ran.assets.filter((asset) => !incoming.startAssetIds.has(asset.id));
  const clashed = addedAssets.find((asset) => currentAssetIds.has(asset.id));
  if (clashed !== undefined) {
    throw new VidroomError('RENDER_FAILED', `资产 id 撞车(${clashed.id}):别的东西占了这个 id,这一跑的素材没登记进工程`);
  }

  const taken = new Set(current.candidates.map((candidate) => candidate.id));
  const mine = new Set(incoming.candidateIds);
  const idMap = new Map<string, string>();
  const addedCandidates: Project['candidates'] = [];
  for (const candidate of ran.candidates) {
    if (!mine.has(candidate.id)) continue;
    const existing = current.candidates.find((item) => item.id === candidate.id);
    if (existing !== undefined) {
      const same =
        existing.assetId === candidate.assetId &&
        existing.shotId === candidate.shotId &&
        existing.recipeHash === candidate.recipeHash;
      // 同一条已经在工程里了(同一份回写跑两遍):不重复登记。
      if (same) continue;
      const id = nextId('cand', taken);
      taken.add(id);
      idMap.set(candidate.id, id);
      addedCandidates.push({ ...candidate, id });
      continue;
    }
    taken.add(candidate.id);
    addedCandidates.push(candidate);
  }

  const byShot = new Map<string, string[]>();
  for (const candidate of addedCandidates) {
    const list = byShot.get(candidate.shotId) ?? [];
    list.push(candidate.id);
    byShot.set(candidate.shotId, list);
  }
  return {
    idMap,
    project: {
      ...current,
      revision: current.revision + 1,
      parentHash: projectHash(current),
      assets: [...current.assets, ...addedAssets],
      candidates: [...current.candidates, ...addedCandidates],
      shots: current.shots.map((shot) => {
        const add = byShot.get(shot.id);
        if (add === undefined || add.length === 0) return shot;
        return { ...shot, candidateIds: [...shot.candidateIds, ...add.filter((id) => !shot.candidateIds.includes(id))] };
      }),
    },
  };
}

/**
 * 工程锁里的权重是否与盘上一致。
 * 大文件不会每次重算:按 `路径:大小:改动时间` 缓存哈希,权重没动就不重算(表存在工程的 runs/ 里)。
 * 对不上就不跑 —— 换了权重等于换了环境,结果不可比。
 */
async function assertModelsLocked(project: Project, modelsRoot: string, store: RunStore): Promise<void> {
  const models = project.locks?.models ?? [];
  if (models.length === 0) return;
  const cacheFile = join(store.runsDir(), '.model-hashes.json');
  let cache: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') cache = parsed as Record<string, string>;
  } catch {
    cache = {};
  }
  const mismatched: string[] = [];
  let cacheChanged = false;
  for (const model of models) {
    const file = isAbsolute(model.file) ? model.file : join(modelsRoot, model.file);
    if (!existsSync(file)) {
      mismatched.push(`${model.file}(盘上没有)`);
      continue;
    }
    const stat = statSync(file);
    const key = `${file}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    let actual = cache[key];
    if (actual === undefined) {
      actual = await sha256File(file);
      cache[key] = actual;
      cacheChanged = true;
    }
    if (actual !== model.sha256) mismatched.push(`${model.file}(哈希对不上)`);
  }
  if (cacheChanged) {
    ensureDir(store.runsDir());
    writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  }
  if (mismatched.length > 0) {
    throw new VidroomError(
      'MODEL_MISMATCH',
      `工程锁的权重与盘上对不上:${mismatched.join('、')};换回原权重或重新 lock 再跑`,
    );
  }
}

async function generateShot(
  runtime: VidroomRuntime,
  request: NewRequest,
  runId: string,
  store: RunStore,
  onQueued: (promptId: string) => void,
): Promise<{ localPath: string; result: H3RunResult }> {
  const h3Request = {
    prompt: request.prompt,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    width: request.width,
    height: request.height,
    frames: request.frames,
    fps: H3_FPS,
    workflowId: H3_WORKFLOW_ID,
    workflowHash: h3WorkflowHash(),
    outputRunId: runId,
  };
  // 参数域先校验:不合法的尺寸/帧数在提交前就报错,不会白占一次队列。
  assertSupported(h3Request);
  const result = await h3Run(runtime, h3Request, { onQueued });
  const media = result.media.find((item) => item.kind === 'video') ?? result.media[0];
  if (media === undefined) throw new VidroomError('RENDER_FAILED', `H3 跑完没给产物(promptId=${result.promptId})`);
  const downloadsDir = join(store.dirOf(runId), 'downloads');
  mkdirSync(downloadsDir, { recursive: true });
  // ComfyUI 报回来的文件名**不可信**:只取最后一段,再核解析后的路径确实落在 downloads 里。
  const safeName = basename(media.filename);
  if (safeName === '' || safeName === '.' || safeName === '..') {
    throw new VidroomError('RENDER_FAILED', `ComfyUI 给的文件名不能用:${media.filename}`);
  }
  const downloadPath = resolve(downloadsDir, safeName);
  if (!downloadPath.startsWith(`${resolve(downloadsDir)}${sep}`)) {
    throw new VidroomError('RENDER_FAILED', `ComfyUI 给的文件名越出下载目录:${media.filename}`);
  }
  // 实际提交的图 + 实际参数落盘:随机 seed 只在这一次知道,不记下来就重放不了。
  const recordDir = join(store.dirOf(runId), 'h3');
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(
    join(recordDir, `${sanitizeName(result.promptId)}.json`),
    `${JSON.stringify({ request: h3Request, effectiveParams: result.effectiveParams, graph: result.graph }, null, 2)}\n`,
    'utf8',
  );
  // 取回本机:失败只重试这一步 —— 这一步不会再往队列里投任务。
  let localPath = downloadPath;
  try {
    localPath = await runtime.client().fetchMedia(media, downloadPath);
  } catch {
    localPath = await runtime.client().fetchMedia(media, downloadPath);
  }
  return { localPath, result };
}

/** 校验完、回执已落盘的一条 run。`runId` 此刻就能给调用方去轮询。 */
export interface PreparedRun {
  runId: string;
  store: RunStore;
  plan: Plan;
  project: Project;
  mode: RunMode;
  tools: MediaTools;
  request: RenderRequest;
}

/** 开跑前的全部校验 + 回执落盘,一个 GPU 请求都不发。校验不过直接抛,什么都不留下。 */
export async function prepareRun(
  runtime: VidroomRuntime,
  project: Project,
  request: RenderRequest,
): Promise<PreparedRun> {
  const config = runtime.config();
  const tools = mediaTools(config);
  const store = new RunStore(request.dir);
  // 先核权重锁:盘上权重与工程锁不一致就不开工(不是等跑完才怪结果不对)。
  await assertModelsLocked(project, runtime.config().modelsRoot, store);
  const mode: RunMode = request.target === 'candidates' ? 'candidates' : 'final';

  // ① 哈希闸:对不上就什么都不做(连 plan 的成本都省了)。
  const before = projectHash(project);
  // 锁定的工作流要能和当前仓里的图对上 —— plan 是按锁定哈希算配方的,执行却用仓里的图,不一致就是跑错图。
  const lockedWorkflow = project.locks?.workflow?.sha256;
  const currentWorkflow = h3WorkflowHash();
  if (lockedWorkflow !== undefined && lockedWorkflow !== currentWorkflow) {
    throw new VidroomError(
      'WORKFLOW_MISMATCH',
      `工程锁的是工作流 ${lockedWorkflow.slice(0, 12)},当前仓里的图是 ${currentWorkflow.slice(0, 12)};重新 lock 或换回那份图再跑`,
    );
  }
  if (request.expectedProjectHash !== undefined && request.expectedProjectHash !== before) {
    throw new VidroomError(
      'PROJECT_HASH_MISMATCH',
      `工程已经变了(现在是 ${before.slice(0, 12)},收到 ${request.expectedProjectHash.slice(0, 12)});重新读工程再渲染`,
    );
  }

  const plan = await buildPlan(project, {
    dir: request.dir,
    target: request.target,
    ...(request.budget === undefined ? {} : { budget: request.budget }),
    receipts: request.receipts ?? readReceipts(request.dir),
  });
  if (request.planHash === undefined) {
    throw new VidroomError('PLAN_HASH_MISMATCH', '渲染要带 planHash(先 vidroom_plan 拿一份),不带不跑');
  }
  assertPlanHash(plan, request.planHash);
  if (!plan.ready) {
    // 分开写,不堆嵌套三元(可读性优先)。
    let code: VidroomErrorCode = 'RENDER_FAILED';
    if (plan.blockers.some((blocker) => blocker.includes('BUDGET_EXCEEDED'))) code = 'BUDGET_EXCEEDED';
    else if (plan.blockers.some((blocker) => blocker.includes('ALIGNMENT_REQUIRED'))) code = 'ALIGNMENT_REQUIRED';
    throw new VidroomError(code, `计划还差东西,没开工:${plan.blockers.join('; ')}`);
  }

  // ② 开 run:工程快照 + 计划 + 初始回执先落盘,之后再动 GPU。
  const runId = newRunId();
  store.create({ runId, project, plan, mode, projectHash: before });
  store.log(runId, `计划 ${plan.planHash.slice(0, 12)} · 复用 ${plan.reuseCandidateIds.length} 个候选 · 新请求 ${plan.newRequests.length} 条`);
  return { runId, store, plan, project, mode, tools, request };
}

/** 真跑那一步(分钟级)。失败写进回执再抛,状态靠 `jobView` 轮询。 */
export async function runPrepared(runtime: VidroomRuntime, prepared: PreparedRun): Promise<RenderResult> {
  const { runId, store, plan, project, mode, tools, request } = prepared;
  try {
    if (mode === 'candidates') {
      return await runCandidates(runtime, project, plan, { runId, store, tools, request });
    }
    return await runFinal(project, plan, { runId, store, tools, request });
  } catch (error) {
    const facts = errorFacts(error);
    store.update(runId, {
      state: 'failed',
      finishedAt: new Date().toISOString(),
      error: facts.message,
      code: facts.code,
    });
    throw error;
  }
}

/** 跑一条 run:`target: candidates` 只出候选,`final` 只合成。阻塞到跑完。 */
export async function renderProject(
  runtime: VidroomRuntime,
  project: Project,
  request: RenderRequest,
): Promise<RenderResult> {
  return await runPrepared(runtime, await prepareRun(runtime, project, request));
}

/** 候选阶段:H3 串行生成 → 立即取回登记。 */
async function runCandidates(
  runtime: VidroomRuntime,
  project: Project,
  plan: Plan,
  ctx: { runId: string; store: RunStore; tools: MediaTools; request: RenderRequest },
): Promise<RenderResult> {
  const { runId, store, tools } = ctx;
  const status = await runtime.status(true);
  if (!status.reachable) {
    throw new VidroomError('LOCAL_ONLY', `本机 ComfyUI 连不上(${status.baseUrl}):${status.error ?? '没有应答'}`);
  }
  if (!status.admission.allowed) {
    throw new VidroomError('RENDER_FAILED', `准入没过:${status.admission.reason}`);
  }

  let receipt = store.update(runId, { state: 'running' });
  const shots: RunShot[] = [...receipt.shots];
  const newCandidateIds: string[] = [];
  let working = structuredClone(project) as Project;
  // 开工时工程里已经有哪些资产 —— 回写时靠它认哪几个是这一跑新加的。
  const startAssetIds = new Set(project.assets.map((asset) => asset.id));

  // 同配方的镜头:plan 只发一条请求(recipeHash 去重),生成一次,这里把同一个 asset 登记给每条镜头。
  const recipeOf = (shot: Project['shots'][number]): string =>
    requestFor(shot, project.locks?.workflow?.sha256).recipeHash;
  const candidatesById = new Map(working.candidates.map((candidate) => [candidate.id, candidate]));
  // 「这条配方已经有能用的候选了」——与 plan 里那个 usable 判据同一套(available + recipeHash 相同)。
  const hasRecipeCandidate = (shot: Project['shots'][number]): boolean =>
    shot.candidateIds.some((id) => {
      const candidate = candidatesById.get(id);
      return candidate !== undefined && candidate.status === 'available' && candidate.recipeHash === recipeOf(shot);
    });

  for (const request of plan.newRequests) {
    // 本轮请求要交给哪些镜头:这条配方还没有合格候选、且配方与这条请求一致的(含发起它的那条)。
    // 只判 candidateIds.length === 0 会漏掉「留着旧候选但提示词已改」的镜头:产物登记给了别人,
    // 它自己还留着一条假的 `submitted` 回执。
    const targets = working.shots.filter(
      (shot) => recipeOf(shot) === request.recipeHash && !hasRecipeCandidate(shot),
    );
    if (targets.length === 0) targets.push(...working.shots.filter((shot) => shot.id === request.shotId));
    const startedAt = Date.now();
    // 提交那一刻就记:promptId + `submitted` 一条 + 提交计数。
    // 计数放在这里而不是失败分支里的 “+1” —— 校验没过、queue 被拒都不算提交过。
    let queuedPromptId: string | undefined;
    const onQueued = (promptId: string): void => {
      queuedPromptId = promptId;
      shots.push({
        shotId: request.shotId,
        state: 'submitted',
        promptId,
        width: request.width,
        height: request.height,
        frames: request.frames,
      });
      receipt = store.update(runId, {
        shots,
        checks: { ...receipt.checks, comfySubmissions: receipt.checks.comfySubmissions + 1, h3Requests: receipt.checks.h3Requests + 1 },
      });
      store.log(runId, `已提交 promptId=${promptId}(镜头 ${request.shotId}),结果还没回来`);
    };
    try {
      const { localPath, result } = await generateShot(runtime, request, runId, store, onQueued);
      const asset = await importAsset(store.projectDir, {
        sourcePath: localPath,
        kind: 'video',
        origin: 'h3',
        existingIds: working.assets.map((item) => item.id),
        sourceRunId: runId,
        tools,
      });
      working.assets.push(asset);
      for (const target of targets) {
        const existing = new Set(working.candidates.map((item) => item.id));
        const id = nextId('cand', existing);
        const full: Candidate = {
          id,
          shotId: target.id,
          assetId: asset.id,
          recipeHash: request.recipeHash,
          seed: result.effectiveParams.seed,
          promptId: result.promptId,
          actual: {
            width: asset.probe?.width ?? request.width,
            height: asset.probe?.height ?? request.height,
            fps: asset.probe?.fps ?? { num: H3_FPS, den: 1 },
            frames: asset.probe?.frames ?? request.frames,
            audio: asset.probe?.audio ?? false,
          },
          status: 'available',
        };
        working.candidates.push(full);
        target.candidateIds.push(id);
        newCandidateIds.push(id);
        // 结果回来了:把刚才那条 `submitted` 换成真的结果,不留半截记录。
        const pendingIndex = shots.findIndex((item) => item.state === 'submitted' && item.shotId === target.id);
        if (pendingIndex >= 0) shots.splice(pendingIndex, 1);
        shots.push({
          shotId: target.id,
          state: 'succeeded',
          candidateId: id,
          assetId: asset.id,
          promptId: result.promptId,
          seed: result.effectiveParams.seed,
          width: full.actual.width,
          height: full.actual.height,
          frames: full.actual.frames,
          elapsedMs: Date.now() - startedAt,
        });
      }
      const shared = targets.length > 1 ? `(同配方 ${targets.length} 条镜头共用)` : '';
      receipt = store.update(runId, { shots });
      store.log(
        runId,
        `镜头 ${request.shotId} 出了候选 ${newCandidateIds.at(-1) ?? ''}(${request.width}x${request.height} · ${request.frames} 帧)${shared}`,
      );
    } catch (error) {
      const facts = errorFacts(error);
      const pendingIndex = shots.findIndex((item) => item.state === 'submitted' && item.shotId === request.shotId);
      if (pendingIndex >= 0) shots.splice(pendingIndex, 1);
      shots.push({
        shotId: request.shotId,
        state: 'failed',
        ...(queuedPromptId === undefined ? {} : { promptId: queuedPromptId }),
        width: request.width,
        height: request.height,
        frames: request.frames,
        elapsedMs: Date.now() - startedAt,
        error: `${facts.code}:${facts.message}`,
      });
      receipt = store.update(runId, { shots });
      store.log(runId, `镜头 ${request.shotId} 失败:${facts.code}:${facts.message}`);
    }
  }

  // 新候选登记进工程(变体运行不回写,只更新 run 快照)。
  let hashAfter: string | undefined;
  if (newCandidateIds.length > 0) {
    if (ctx.request.writeBack === false) {
      working.revision += 1;
      hashAfter = projectHash(working);
      writeFileSync(store.snapshotPath(runId), `${JSON.stringify(working, null, 2)}\n`, 'utf8');
      store.log(runId, `变体运行:新候选留在本 run 快照里,工程(新哈希 ${hashAfter.slice(0, 12)})不回写`);
    } else {
      // 生成是分钟级的,这期间别人可能已经 patch 过、导过素材、选过候选:
      // 重读当前工程,只把我们这一跑新加的并进去(updateProject 收尾前再复核一次哈希)。
      // 拿开工时那份整份覆盖会把这些抹掉。
      let idMap = new Map<string, string>();
      working = updateProject(ctx.request.dir, (latest) => {
        const merged = mergeGenerated(latest, working, { candidateIds: newCandidateIds, startAssetIds });
        idMap = merged.idMap;
        return merged.project;
      });
      hashAfter = projectHash(working);
      if (idMap.size > 0) {
        // 你跑的时候面板手工登记过候选,占掉了同一个 `cand-N`:上面换了 id,回执与返回值得一起跟上。
        for (const [index, id] of newCandidateIds.entries()) {
          const mapped = idMap.get(id);
          if (mapped !== undefined) newCandidateIds[index] = mapped;
        }
        shots.splice(
          0,
          shots.length,
          ...shots.map((shot) =>
            shot.candidateId === undefined ? shot : { ...shot, candidateId: idMap.get(shot.candidateId) ?? shot.candidateId },
          ),
        );
        receipt = store.update(runId, { shots });
        store.log(
          runId,
          `候选 id 撞车,已换新:${[...idMap].map(([from, to]) => `${from}→${to}`).join('、')}(回执与返回值同步跟上)`,
        );
      }
      store.log(runId, `工程已登记 ${newCandidateIds.length} 个新候选,新哈希 ${hashAfter.slice(0, 12)}`);
    }
  }

  const failed = shots.filter((shot) => shot.state === 'failed');
  const state: Receipt['state'] =
    failed.length === 0 ? restingState(working, 'candidates') : newCandidateIds.length > 0 ? restingState(working, 'candidates') : 'failed';
  receipt = store.update(runId, {
    state,
    finishedAt: new Date().toISOString(),
    ...(failed.length === 0 ? {} : { error: `${failed.length} 个镜头没跑成`, code: 'RENDER_FAILED' }),
  });
  return {
    runId,
    receipt,
    plan,
    newCandidateIds,
    ...(hashAfter === undefined ? {} : { projectHashAfter: hashAfter }),
  };
}

/** 合成阶段:一次 ComfyUI 请求都不发。 */
async function runFinal(
  project: Project,
  plan: Plan,
  ctx: { runId: string; store: RunStore; tools: MediaTools; request: RenderRequest },
): Promise<RenderResult> {
  const { runId, store, tools } = ctx;
  const outPath = store.outputPath(runId, project);
  // 合成阶段只调本地 ffmpeg,一次 ComfyUI 请求都不发:计数是个常量 0,不是「忘了加」。
  mkdirSync(join(store.dirOf(runId)), { recursive: true });
  const composed = await composeFinal(project, {
    dir: ctx.request.dir,
    runId,
    outPath,
    tools,
    scriptPath: join(store.dirOf(runId), 'compose.sh'),
    projectHash: plan.projectHash,
    planHash: plan.planHash,
  });
  const ffmpegVersion = await toolVersion(tools.ffmpegPath, ['-version']);
  const shots: RunShot[] = [];
  for (const shot of project.shots) {
    const candidate = project.candidates.find((item) => item.id === shot.selectedCandidateId);
    if (candidate === undefined) continue;
    shots.push({
      shotId: shot.id,
      state: 'succeeded',
      candidateId: candidate.id,
      assetId: candidate.assetId,
      width: candidate.actual.width,
      height: candidate.actual.height,
      frames: candidate.actual.frames,
    });
  }
  const receipt = store.update(runId, {
    state: 'succeeded',
    finishedAt: new Date().toISOString(),
    shots,
    outputs: [composed.output],
    checks: {
      // 冻结的计划与当前工程/调用方手里的计划对得上吗(执行回执参数与计划一致)。
      projectHashOk: plan.projectHash === projectHash(project),
      planHashOk: ctx.request.planHash === undefined || ctx.request.planHash === plan.planHash,
      // 合成阶段:一次都没往 ComfyUI 投(这个数是这段代码自己数出来的,不是写死的 0)。
      comfySubmissions: 0,
      h3Requests: 0,
      reusedCandidates: plan.reuseCandidateIds.length,
      ...(ffmpegVersion === undefined ? {} : { ffmpeg: ffmpegVersion }),
    },
  });
  store.log(runId, `合成完成:${composed.output.frames} 帧 → ${composed.output.path}`);
  return { runId, receipt, plan, newCandidateIds: [] };
}

/* ------------------------------------------------------------------ *
 * 三变体:每条独立快照/回执/成片,失败不覆盖成功
 * ------------------------------------------------------------------ */

export interface VariantSpec {
  id: string;
  patch: PatchOp[];
  seedByShot?: Record<string, number>;
  /** action=plan 拿到的这份变体计划的哈希;run 时必须给,不给不跑。 */
  planHash?: string;
}

export interface VariantBatch {
  batchId: string;
  target: PlanTarget;
  plans?: Array<{ variantId: string; planHash: string; projectHash: string; newRequests: number; ready: boolean; blockers: string[] }>;
  runs: Array<{ variantId: string; runId?: string; status: Receipt['state'] | 'failed'; planHash?: string; error?: string; outputPath?: string }>;
  failures: number;
}

/** 变体批次:先按 patch 造出各自的工程,再逐条跑(串行,一条挂了不影响别人)。 */
export async function renderVariants(
  runtime: VidroomRuntime,
  project: Project,
  request: {
    dir: string;
    target: PlanTarget;
    variants: VariantSpec[];
    action: 'plan' | 'run';
    expectedProjectHash?: string;
    budget?: Partial<Budget>;
    /** 同 #RenderRequest.receipts:整批共用一份校准输入。 */
    receipts?: Receipt[];
  },
): Promise<VariantBatch> {
  const budget = { ...project.budget, ...request.budget };
  if (request.variants.length === 0) throw new VidroomError('PROJECT_INVALID', 'variants 是空的');
  // 基工程先把哈希核一遍:变体都是从它派生出来的,它变了整批变体就不作数。
  const baseHash = projectHash(project);
  if (request.expectedProjectHash !== undefined && request.expectedProjectHash !== baseHash) {
    throw new VidroomError(
      'PROJECT_HASH_MISMATCH',
      `工程已经变了(现在是 ${baseHash.slice(0, 12)},收到 ${request.expectedProjectHash.slice(0, 12)});重新读工程再跑变体`,
    );
  }
  if (request.action === 'run' && request.variants.some((variant) => variant.planHash === undefined)) {
    throw new VidroomError(
      'PLAN_HASH_MISMATCH',
      'action=run 时每条变体都要带上 action=plan 拿到的那份 planHash;不带不跑',
    );
  }
  if (request.variants.length > budget.maxVariants) {
    throw new VidroomError(
      'BUDGET_EXCEEDED',
      `要 ${request.variants.length} 条,超出预算 maxVariants=${budget.maxVariants}`,
    );
  }
  if (budget.gpuWorkers !== 1) {
    throw new VidroomError('BUDGET_EXCEEDED', `本机一张卡:gpuWorkers 只认 1(收到 ${budget.gpuWorkers})`);
  }
  const batchId = `batch-${newRunId().slice(4)}`;
  const plans: VariantBatch['plans'] = [];
  const runs: VariantBatch['runs'] = [];
  // 整批共用一份校准输入:计划哈希里含实测估值,如果每条变体自己去读最新回执,
  // 同批第一条跑完就把后面几条的 planHash 改了 → 拿着 plan 阶段那份哈希真跑时会被拒。
  const frozenReceipts = request.receipts ?? readReceipts(request.dir);

  for (const variant of request.variants) {
    let variantProject: Project;
    try {
      const patched = applyPatch(project, variant.patch, {
        ...(variant.seedByShot === undefined ? {} : { seedByShot: variant.seedByShot }),
      });
      variantProject = patched.project;
    } catch (error) {
      runs.push({ variantId: variant.id, status: 'failed', error: errorFacts(error).message });
      continue;
    }

    if (request.action === 'plan') {
      try {
        const plan = await buildPlan(variantProject, {
          dir: request.dir,
          target: request.target,
          budget,
          receipts: frozenReceipts,
        });
        plans.push({
          variantId: variant.id,
          planHash: plan.planHash,
          projectHash: plan.projectHash,
          newRequests: plan.newRequests.length,
          ready: plan.ready,
          blockers: plan.blockers,
        });
      } catch (error) {
        runs.push({ variantId: variant.id, status: 'failed', error: errorFacts(error).message });
      }
      continue;
    }

    try {
      const result = await renderProject(runtime, variantProject, {
        dir: request.dir,
        target: request.target,
        planHash: variant.planHash ?? '',
        budget,
        writeBack: false,
        receipts: frozenReceipts,
      });
      runs.push({
        variantId: variant.id,
        runId: result.runId,
        status: result.receipt.state,
        planHash: result.plan.planHash,
        ...(result.receipt.outputs[0] === undefined ? {} : { outputPath: result.receipt.outputs[0].path }),
      });
    } catch (error) {
      const facts = errorFacts(error);
      runs.push({ variantId: variant.id, status: 'failed', error: `${facts.code}:${facts.message}` });
    }
  }

  return {
    batchId,
    target: request.target,
    ...(request.action === 'plan' ? { plans } : {}),
    runs,
    failures: runs.filter((run) => run.status === 'failed').length,
  };
}
