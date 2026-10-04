/**
 * 渲染编排:一条 run 从「冻结的计划」走到「候选 / 成片 + 回执」。
 *
 * 三条纪律:
 * ① **先核哈希再动 GPU** —— 工程哈希或计划哈希对不上,一个 ComfyUI 请求都不发;
 * ② **H3 单 worker 串行**(本机一张卡,`budget.gpuWorkers` 只认 1),候选按配方去重;
 * ③ 生成完的素材**立刻取回本机并登记进工程**,不靠 ComfyUI 的内存历史复跑。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { H3_WORKFLOW_ID, assertSupported, h3Run, h3WorkflowHash } from './adapter.js';
import { alignmentIssues } from './align.js';
import { composeFinal } from './compose.js';
import { mediaTools } from './config.js';
import { VidroomError, errorFacts } from './errors.js';
import { toolVersion, type MediaTools } from './media.js';
import { assertPlanHash, buildPlan, readReceipts, requestFor, type NewRequest, type Plan, type PlanTarget } from './plan.js';
import { applyPatch, importAsset, nextId, resolveInside, writeProject } from './project-io.js';
import { H3_FPS } from './frames.js';
import { projectHash, type Budget, type Candidate, type PatchOp, type Project } from './project.js';
import { RunStore, newRunId, type Receipt, type RunMode, type RunShot } from './receipts.js';
import type { VidroomRuntime } from './runtime.js';

export interface RenderRequest {
  dir: string;
  target: PlanTarget;
  /** 调用方手里的工程哈希(乐观并发):对不上就拒,不往下走。 */
  expectedProjectHash?: string;
  /** plan 时拿到的计划哈希;对不上说明计划已经过时。 */
  planHash?: string;
  budget?: Partial<Budget>;
  /** 变体运行为 false:新候选只进 run 快照,不回写工程。 */
  writeBack?: boolean;
  variantId?: string;
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

/** 候选请求 → ComfyUI 的一次提交 + 把产物取回本机(登记交给调用方,它才看得到工程现状)。 */
async function generateShot(
  runtime: VidroomRuntime,
  request: NewRequest,
  runId: string,
  store: RunStore,
): Promise<{ localPath: string; filename: string }> {
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
  const result = await h3Run(runtime, h3Request);
  const media = result.media.find((item) => item.kind === 'video') ?? result.media[0];
  if (media === undefined) throw new VidroomError('RENDER_FAILED', `H3 跑完没给产物(promptId=${result.promptId})`);
  const downloadPath = join(store.dirOf(runId), 'downloads', media.filename);
  mkdirSync(join(store.dirOf(runId), 'downloads'), { recursive: true });
  // 取回本机:失败只重试这一步 —— 这一步不会再往队列里投任务。
  let localPath = downloadPath;
  try {
    localPath = await runtime.client().fetchMedia(media, downloadPath);
  } catch {
    localPath = await runtime.client().fetchMedia(media, downloadPath);
  }
  return { localPath, filename: media.filename };
}

/** 跑一条 run:`target: candidates` 只出候选,`final` 只合成。 */
export async function renderProject(
  runtime: VidroomRuntime,
  project: Project,
  request: RenderRequest,
): Promise<RenderResult> {
  const config = runtime.config();
  const tools = mediaTools(config);
  const store = new RunStore(request.dir);
  const mode: RunMode = request.target === 'candidates' ? 'candidates' : 'final';

  // ① 哈希闸:对不上就什么都不做(连 plan 的成本都省了)。
  const before = projectHash(project);
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
    receipts: readReceipts(request.dir),
  });
  if (request.planHash !== undefined) assertPlanHash(plan, request.planHash);
  if (!plan.ready) {
    const budgetProblem = plan.blockers.some((blocker) => blocker.includes('BUDGET_EXCEEDED'));
    const alignmentProblem = plan.blockers.some((blocker) => blocker.includes('ALIGNMENT_REQUIRED'));
    throw new VidroomError(
      budgetProblem ? 'BUDGET_EXCEEDED' : alignmentProblem ? 'ALIGNMENT_REQUIRED' : 'RENDER_FAILED',
      `计划还差东西,没开工:${plan.blockers.join('; ')}`,
    );
  }

  // ② 开 run:工程快照 + 计划 + 初始回执先落盘,之后再动 GPU。
  const runId = newRunId();
  store.create({ runId, project, plan, mode, projectHash: before });
  store.log(runId, `计划 ${plan.planHash.slice(0, 12)} · 复用 ${plan.reuseCandidateIds.length} 个候选 · 新请求 ${plan.newRequests.length} 条`);

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
  const working = structuredClone(project) as Project;

  // 同配方的镜头:plan 只发一条请求(recipeHash 去重),生成一次,这里把同一个 asset 登记给每条镜头。
  const recipeOf = (shot: Project['shots'][number]): string =>
    requestFor(shot, project.locks?.workflow?.sha256).recipeHash;

  for (const request of plan.newRequests) {
    // 本轮请求要交给哪些镜头:还没候选、且配方与这条请求一致的(含发起它的那条)。
    const targets = working.shots.filter(
      (shot) => shot.candidateIds.length === 0 && recipeOf(shot) === request.recipeHash,
    );
    if (targets.length === 0) targets.push(...working.shots.filter((shot) => shot.id === request.shotId));
    const startedAt = Date.now();
    try {
      const { localPath } = await generateShot(runtime, request, runId, store);
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
          ...(request.seed === undefined ? {} : { seed: request.seed }),
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
        shots.push({
          shotId: target.id,
          state: 'succeeded',
          candidateId: id,
          assetId: asset.id,
          width: full.actual.width,
          height: full.actual.height,
          frames: full.actual.frames,
          elapsedMs: Date.now() - startedAt,
        });
      }
      const shared = targets.length > 1 ? `(同配方 ${targets.length} 条镜头共用)` : '';
      receipt = store.update(runId, {
        shots,
        checks: { ...receipt.checks, comfySubmissions: receipt.checks.comfySubmissions + 1, h3Requests: receipt.checks.h3Requests + 1 },
      });
      store.log(
        runId,
        `镜头 ${request.shotId} 出了候选 ${newCandidateIds.at(-1) ?? ''}(${request.width}x${request.height} · ${request.frames} 帧)${shared}`,
      );
    } catch (error) {
      const facts = errorFacts(error);
      shots.push({
        shotId: request.shotId,
        state: 'failed',
        width: request.width,
        height: request.height,
        frames: request.frames,
        elapsedMs: Date.now() - startedAt,
        error: `${facts.code}:${facts.message}`,
      });
      receipt = store.update(runId, {
        shots,
        checks: { ...receipt.checks, comfySubmissions: receipt.checks.comfySubmissions + 1, h3Requests: receipt.checks.h3Requests + 1 },
      });
      store.log(runId, `镜头 ${request.shotId} 失败:${facts.code}:${facts.message}`);
    }
  }

  // 新候选登记进工程(变体运行不回写,只更新 run 快照)。
  let hashAfter: string | undefined;
  if (newCandidateIds.length > 0) {
    working.revision += 1;
    hashAfter = projectHash(working);
    if (ctx.request.writeBack === false) {
      writeFileSync(store.snapshotPath(runId), `${JSON.stringify(working, null, 2)}\n`, 'utf8');
      store.log(runId, `变体运行:新候选留在本 run 快照里,工程(新哈希 ${hashAfter.slice(0, 12)})不回写`);
    } else {
      writeProject(ctx.request.dir, working);
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
  // 合成阶段只调本地 ffmpeg:这里记个数,回执里报的是真实计数。
  let comfySubmissions = 0;
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
      comfySubmissions,
      h3Requests: comfySubmissions,
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
    planHash?: string;
    expectedProjectHash?: string;
    budget?: Partial<Budget>;
  },
): Promise<VariantBatch> {
  const budget = { ...project.budget, ...request.budget };
  if (request.variants.length === 0) throw new VidroomError('PROJECT_INVALID', 'variants 是空的');
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
          receipts: readReceipts(request.dir),
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
        ...(request.planHash === undefined ? {} : { planHash: request.planHash }),
        budget,
        writeBack: false,
        variantId: variant.id,
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

/** 一个工程用到的资产文件是否都在(面板/工具报缺件用)。 */
export function missingAssets(project: Project, dir: string): string[] {
  const missing: string[] = [];
  for (const asset of project.assets) {
    try {
      if (!existsSync(resolveInside(dir, asset.path, `资产 ${asset.id} 的路径`))) missing.push(asset.id);
    } catch {
      missing.push(asset.id);
    }
  }
  return missing;
}
