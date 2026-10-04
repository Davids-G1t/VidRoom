/**
 * 第 2 批的工具面:`vr.project/1` 工程的读写、计划、参考分析、词对齐、渲染、变体。
 *
 * 这里只放「给模型看的说明 + 参数 schema」,活儿全在 `project-ops.ts` 里 ——
 * 面板路由走同一批函数,所以聊天工具与面板看到的数字/错误码必然一致。
 */

import { h3Capabilities, h3Job, h3Run, type H3Request } from './adapter.js';
import type { Config } from './config.js';
import { VidroomError } from './errors.js';
import {
  alignSegment,
  candidateId,
  createProject,
  inspectProject,
  jobView,
  listAssets,
  listCandidates,
  missingAssets,
  openProject,
  patchProject,
  planProject,
  projectDirOf,
  registerReference,
  startRender,
} from './project-ops.js';
import { importAsset, readProject, writeProject } from './project-io.js';
import { H3_MODEL, projectHash, validateProject, type Budget, type PatchOp, type Project } from './project.js';
import { renderVariants, type VariantSpec } from './render.js';
import type { VidroomRuntime } from './runtime.js';
import { mediaTools } from './config.js';
import type { HostContext } from './tools.js';

/** 快操作的超时。 */
const FAST_TIMEOUT_MS = 60_000;
/** 参考登记要抽帧/读探针,慢一档。 */
const REFERENCE_TIMEOUT_MS = 600_000;
/** 计划要读历史回执,但不动 GPU。 */
const PLAN_TIMEOUT_MS = 120_000;
/** 真出片的工具。 */
const GENERATE_TIMEOUT_MS = 3_600_000;

type Args = Record<string, unknown>;

function text(value: string): unknown[] {
  return [{ type: 'text', text: value }];
}

/** 参数取值:类型不对就当场报错,不拿默认值糊过去。 */
function need(args: Args, key: string): unknown {
  const value = args[key];
  if (value === undefined || value === null) throw new VidroomError('PROJECT_INVALID', `缺少参数 ${key}`);
  return value;
}

function str(args: Args, key: string, required = true): string {
  const value = required ? need(args, key) : args[key];
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VidroomError('PROJECT_INVALID', `${key} 要是非空字符串`);
  }
  return value.trim();
}

function optStr(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new VidroomError('PROJECT_INVALID', `${key} 要是字符串`);
  return value.trim() === '' ? undefined : value.trim();
}

function optNum(args: Args, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new VidroomError('PROJECT_INVALID', `${key} 要是数字`);
  }
  return value;
}

function target(args: Args): 'candidates' | 'final' {
  const value = str(args, 'target');
  if (value !== 'candidates' && value !== 'final') {
    throw new VidroomError('PROJECT_INVALID', `target 只能是 candidates 或 final(收到 ${value})`);
  }
  return value;
}

function budgetOf(args: Args, project: Project): Partial<Budget> | undefined {
  const raw = args.budget;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new VidroomError('PROJECT_INVALID', 'budget 要是对象');
  return { ...project.budget, ...(raw as Partial<Budget>) };
}

function patchOf(args: Args): PatchOp[] {
  const raw = args.patch;
  if (!Array.isArray(raw) || raw.length === 0) throw new VidroomError('PROJECT_INVALID', 'patch 要是非空数组');
  return raw as PatchOp[];
}

/** 一个工具定义(宿主 tools 服务认的形状,和批 1 一致)。 */
interface ToolDefinition {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  output: {
    schema: { type: 'object' };
    render(args: unknown, value: unknown): unknown[];
    presentationMeta(args: unknown, value: unknown): unknown;
  };
  timeoutMs: number;
  execute(args: Args): Promise<unknown>;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  timeoutMs: number,
  handler: (args: Args) => Promise<Record<string, unknown> & { summary: string }>,
): ToolDefinition {
  return {
    name,
    description: description.trim(),
    parameters: { type: 'object', properties, required },
    output: {
      schema: { type: 'object' },
      render(_args: unknown, value: unknown): unknown[] {
        const result = value as { summary?: string };
        return text(result.summary ?? JSON.stringify(value));
      },
      presentationMeta(_args: unknown, value: unknown): unknown {
        return value;
      },
    },
    timeoutMs,
    async execute(args: Args): Promise<unknown> {
      return handler(args);
    },
  };
}

const PROJECT_PATH = {
  type: 'string',
  description: '工程目录(或目录里的 project.vr.json)。',
};
const BASE_HASH = {
  type: 'string',
  description: '调用方手里的工程哈希(乐观并发);对不上就拒,防覆盖别人的改动。',
};

/** 注册第 2 批的全部工具,返回摘除函数。 */
export function registerVidroomProjectTools(ctx: HostContext, runtime: VidroomRuntime): Array<() => void> {
  const config: Config = runtime.config();

  const reference = tool(
    'vidroom_reference',
    `登记一条本地参考视频,把它的镜头结构抽成切镜候选(只读本机文件,不外发、不下载)。`,
    {
      localPath: { type: 'string', description: '本机参考视频的绝对路径(必需)。' },
      projectPath: { type: 'string', description: '落到哪个工程目录;不给就在 projectsRoot 下新建。' },
      referenceUrl: { type: 'string', description: '来源 URL,只作文字存档(只收本机地址)。' },
    },
    ['localPath'],
    REFERENCE_TIMEOUT_MS,
    async (args) => {
      const view = await registerReference(config, {
        localPath: str(args, 'localPath'),
        projectPath: optStr(args, 'projectPath'),
        referenceUrl: optStr(args, 'referenceUrl'),
      });
      const { summary, ...rest } = view;
      return { ...rest, summary };
    },
  );

  const project = tool(
    'vidroom_project',
    `看或改工程:` +
      `action=inspect 出状态(修订号/工程哈希/镜头候选与锚点等计数/issues);` +
      `action=patch 按 JSON Patch 改并写出,回来告诉你改了哪些路径、哪些镜头被作废、要不要重新对齐;` +
      `action=create 在 projectsRoot 下新建空工程。改之前先 inspect 拿 projectHash 填 baseHash。`,
    {
      projectPath: PROJECT_PATH,
      action: { type: 'string', enum: ['inspect', 'patch', 'create'], description: '默认 inspect。' },
      baseHash: BASE_HASH,
      patch: {
        type: 'array',
        description: 'JSON Patch 操作:{op:"replace"|"add"|"remove", path:"/shots/0/edit/speed", value:…}。',
        items: { type: 'object' },
      },
      projectId: { type: 'string', description: 'action=create 时的工程 id(不给自动生成)。' },
    },
    [],
    FAST_TIMEOUT_MS,
    async (args) => {
      const action = optStr(args, 'action') ?? 'inspect';
      if (action === 'create') {
        const created = createProject(config, optStr(args, 'projectId'));
        const view = inspectProject(created.dir, created.project);
        return { ...view, summary: `新建工程 ${created.project.projectId} → ${created.dir}` };
      }
      const { dir, project: current } = openProject(str(args, 'projectPath'));
      if (action === 'inspect') {
        const view = inspectProject(dir, current);
        return { ...view, summary: `${view.projectId} r${view.revision} · 哈希 ${view.projectHash.slice(0, 12)}` };
      }
      if (action !== 'patch') {
        throw new VidroomError('PROJECT_INVALID', `action 只能是 inspect / patch / create(收到 ${action})`);
      }
      const result = patchProject(dir, current, { baseHash: optStr(args, 'baseHash'), patch: patchOf(args) });
      const view = inspectProject(dir, result.project);
      return {
        ...view,
        changedPaths: result.changedPaths,
        invalidatedShotIds: result.invalidatedShotIds,
        alignmentRequired: result.alignmentRequired,
        previousHash: projectHash(current),
        summary: [
          `工程已改:${result.changedPaths.join(', ')}`,
          result.invalidatedShotIds.length === 0
            ? '没有镜头作废'
            : `${result.invalidatedShotIds.length} 个镜头的候选作废:${result.invalidatedShotIds.join(', ')}`,
          result.alignmentRequired ? '文案/音轨变了:旧词对齐已失效,要重新 vidroom_align_words' : '对齐不用重做',
          `新哈希 ${result.projectHash.slice(0, 12)}`,
        ].join('\n'),
      };
    },
  );

  const plan = tool(
    'vidroom_plan',
    `先算再跑:这条 run 要用哪些候选、要新出多少条(多少帧、大概多久、占多少盘),用的模型/工作流/提示词快照是哪一个。` +
      `目标分两种:candidates 只出候选;final 只合成(复用已选定素材,一条 ComfyUI 请求都不发)。` +
      `返回 planHash,渲染时带回 —— 计划与执行必须对得上。`,
    {
      projectPath: PROJECT_PATH,
      target: { type: 'string', enum: ['candidates', 'final'] },
      budget: {
        type: 'object',
        description: '预算覆盖:{maxVariants,maxNewCandidates,maxDiskBytes,maxWallSeconds,gpuWorkers}。',
      },
    },
    ['projectPath', 'target'],
    PLAN_TIMEOUT_MS,
    async (args) => {
      const { dir, project: current } = openProject(str(args, 'projectPath'));
      const view = await planProject(dir, current, target(args), budgetOf(args, current));
      return { projectPath: dir, ...view };
    },
  );

  const candidates = tool(
    'vidroom_candidates',
    `分页列候选(一个镜头可以有好几条,选中的会标出来)。长列表用 cursor 翻页。`,
    {
      projectPath: PROJECT_PATH,
      shotId: { type: 'string', description: '只看某个镜头的候选。' },
      cursor: { type: 'string', description: '上一页最后一条的 id。' },
      limit: { type: 'number', description: '一页几条,默认 20。' },
    },
    ['projectPath'],
    FAST_TIMEOUT_MS,
    async (args) => {
      const { dir, project: current } = openProject(str(args, 'projectPath'));
      const page = listCandidates(current, {
        shotId: optStr(args, 'shotId'),
        cursor: optStr(args, 'cursor'),
        limit: optNum(args, 'limit'),
      });
      return {
        projectPath: dir,
        ...page,
        summary: `候选 ${page.total} 条,这一页 ${page.items.length} 条${page.nextCursor === undefined ? '(到底了)' : `;下一页从 ${page.nextCursor} 开始`}`,
      };
    },
  );

  const assets = tool(
    'vidroom_assets',
    `列工程里的本地资产(参考片、生成的片段、音轨、字体)与它们的绝对路径、缺件情况。`,
    {
      projectPath: PROJECT_PATH,
      cursor: { type: 'string', description: '上一页最后一条的 id。' },
      limit: { type: 'number', description: '一页几条,默认 20。' },
    },
    ['projectPath'],
    FAST_TIMEOUT_MS,
    async (args) => {
      const { dir, project: current } = openProject(str(args, 'projectPath'));
      const page = listAssets(dir, current, { cursor: optStr(args, 'cursor'), limit: optNum(args, 'limit') });
      const missing = missingAssets(current, dir);
      return {
        projectPath: dir,
        ...page,
        missing,
        summary: `资产 ${page.total} 个,这一页 ${page.items.length} 个${missing.length === 0 ? ';没有缺件' : `;缺件:${missing.join(', ')}`}`,
      };
    },
  );

  const align = tool(
    'vidroom_align_words',
    `手工校订一段文案的词时序(词锚 + 派生字幕/效果)。要给出音轨的 audioHash 与当前 scriptHash —— 对不上说明绑错了轨或文案改过,会直接拒。` +
      `完成后工程里写进 alignment,并按锚点编译字幕与效果。`,
    {
      projectPath: PROJECT_PATH,
      segmentId: { type: 'string', description: '文案段 id。' },
      assetId: { type: 'string', description: '这段人声所在的音轨资产 id。' },
      audioHash: { type: 'string', description: '音轨资产的 sha256(必须与工程里登记的一致)。' },
      scriptHash: { type: 'string', description: '当前 script 的哈希。' },
      wordWindows: {
        type: 'array',
        description: '每词一个窗口:{tokenId, startFrame, endFrame}(段内帧,半开区间,按词升序、不重叠)。',
        items: { type: 'object' },
      },
    },
    ['projectPath', 'segmentId', 'assetId', 'audioHash', 'scriptHash', 'wordWindows'],
    FAST_TIMEOUT_MS,
    async (args) => {
      const { dir, project: current } = openProject(str(args, 'projectPath'));
      const windows = (need(args, 'wordWindows') as Array<{ tokenId: string; startFrame: number; endFrame: number }>).map(
        (window) => ({
          tokenId: String(window.tokenId),
          startFrame: Math.trunc(Number(window.startFrame)),
          endFrame: Math.trunc(Number(window.endFrame)),
        }),
      );
      const view = alignSegment(dir, current, {
        segmentId: str(args, 'segmentId'),
        assetId: str(args, 'assetId'),
        audioHash: str(args, 'audioHash'),
        scriptHash: str(args, 'scriptHash'),
        wordWindows: windows,
      });
      const { summary, ...rest } = view;
      return { ...rest, summary };
    },
  );

  const render = tool(
    'vidroom_render',
    `跑一条 run。mode=compose 只合成(复用已选定候选,ComfyUI 一次都不请求);mode=generate-missing 只补新候选(H3 串行一条条出)。` +
      `先 vidroom_plan 拿 planHash,回来时**必填**带上(对不上不开工)。注意:这个调用等到这一跑结束才回,面板上是边跑边刷的。`,
    {
      projectPath: PROJECT_PATH,
      mode: { type: 'string', enum: ['compose', 'generate-missing'] },
      expectedProjectHash: BASE_HASH,
      planHash: { type: 'string', description: 'vidroom_plan 给的 planHash。**必填**:计划变了就不跑。' },
      budget: { type: 'object', description: '本次预算覆盖。' },
    },
    ['projectPath', 'mode', 'planHash'],
    GENERATE_TIMEOUT_MS,
    async (args) => {
      const mode = str(args, 'mode');
      if (mode !== 'compose' && mode !== 'generate-missing') {
        throw new VidroomError('PROJECT_INVALID', `mode 只能是 compose 或 generate-missing(收到 ${mode})`);
      }
      const dir = projectDirOf(str(args, 'projectPath'));
      const current = readProject(dir);
      const started = await startRender(runtime, {
        dir,
        mode,
        expectedProjectHash: optStr(args, 'expectedProjectHash'),
        planHash: need(args, 'planHash') as string,
        budget: budgetOf(args, current),
      });
      const view = jobView(dir, started.runId);
      return { ...view, summary: `run ${started.runId} 结束状态:${view.receipt?.state ?? '?'}\n${view.summary}` };
    },
  );

  const job = tool(
    'vidroom_job',
    `查运行回执。给 runId 就出那一条(状态、目标、锁、每镜头产物、校验、日志、产物路径);不给就列最近的 run。`,
    {
      projectPath: PROJECT_PATH,
      runId: { type: 'string', description: 'vidroom_render 给的 runId。' },
    },
    ['projectPath'],
    FAST_TIMEOUT_MS,
    async (args) => {
      const dir = projectDirOf(str(args, 'projectPath'));
      const view = jobView(dir, optStr(args, 'runId'));
      const { summary, ...rest } = view;
      return { ...rest, summary };
    },
  );

  const variants = tool(
    'vidroom_variants',
    `批量出变体(几条独立工程快照,每条自己的回执与成片;一条失败不覆盖别人的成果)。` +
      `variants 里每条给 {id, patch:[JSON Patch], seedByShot?, planHash?};action=plan 只算要不要跑、要出多少条;action=run 真跑(这时每条**必须**带 action=plan 给回来的 planHash)。`,
    {
      projectPath: PROJECT_PATH,
      variants: { type: 'array', items: { type: 'object' }, description: '变体列表:{id, patch, seedByShot?, planHash?}' },
      action: { type: 'string', enum: ['plan', 'run'], description: '默认 plan(先看要不要跑)。' },
      target: { type: 'string', enum: ['candidates', 'final'] },
      expectedProjectHash: BASE_HASH,
      budget: { type: 'object', description: '预算覆盖:{maxVariants,maxNewCandidates,maxDiskBytes,maxWallSeconds}。' },
    },
    ['projectPath', 'variants'],
    GENERATE_TIMEOUT_MS,
    async (args) => {
      const { dir, project: current } = openProject(str(args, 'projectPath'));
      const list = need(args, 'variants') as VariantSpec[];
      if (list.length === 0) throw new VidroomError('PROJECT_INVALID', 'variants 是空的');
      if (list.length > current.budget.maxVariants) {
        throw new VidroomError(
          'BUDGET_EXCEEDED',
          `要 ${list.length} 条,超出 maxVariants=${current.budget.maxVariants}`,
        );
      }
      const action = optStr(args, 'action') ?? 'plan';
      if (action !== 'plan' && action !== 'run') {
        throw new VidroomError('PROJECT_INVALID', `action 只能是 plan 或 run(收到 ${action})`);
      }
      const batch = await renderVariants(runtime, current, {
        dir,
        target: target({ target: optStr(args, 'target') ?? 'candidates' }),
        variants: list,
        action,
        expectedProjectHash: optStr(args, 'expectedProjectHash'),
        budget: budgetOf(args, current),
      });
      const summary =
        action === 'plan'
          ? `变体计划(${batch.plans?.length ?? 0} 条):${(batch.plans ?? [])
              .map((item) => `${item.variantId}${item.ready ? '可跑' : `缺${item.blockers.length}项`}(${item.newRequests} 条新请求)`)
              .join(' · ')}`
          : `变体批次 ${batch.batchId}:成功 ${batch.runs.length - batch.failures} 条,失败 ${batch.failures} 条`;
      return { ...batch, summary };
    },
  );

  const h3 = tool(
    'vidroom_h3',
    `MiniMax H3 的适配面:action=capabilities 给出可用参数域(帧数/分辨率网格、是否要显存准入)与用的工作流 id/哈希;` +
      `action=run 按显式参数跑一次(给出提交时的完整参数快照与实测参数);action=status 按 promptId 查一次真实状态。` +
      `参数不合规会被拒(UNSUPPORTED_PARAMS),不会把请求发出去。`,
    {
      action: { type: 'string', enum: ['capabilities', 'run', 'status'], description: '默认 capabilities。' },
      prompt: { type: 'string', description: 'action=run:画面描述。' },
      seed: { type: 'number', description: 'action=run:随机种子。' },
      width: { type: 'number', description: 'action=run:宽(要落在 H3 的 32 倍数网格上)。' },
      height: { type: 'number', description: 'action=run:高。' },
      frames: { type: 'number', description: 'action=run:帧数(必须是 17k+5)。' },
      fps: { type: 'number', description: 'action=run:帧率,默认 24。' },
      promptId: { type: 'string', description: 'action=status:vidroom_h3 run 给的 promptId。' },
    },
    [],
    GENERATE_TIMEOUT_MS,
    async (args) => {
      const action = optStr(args, 'action') ?? 'capabilities';
      const status = await runtime.status(true);
      if (action === 'capabilities') {
        const capabilities = h3Capabilities({
          reachable: status.reachable,
          admissionAllowed: status.admission.allowed,
          admissionReason: status.admission.reason,
        });
        return {
          capabilities,
          status,
          summary: [
            `H3 参数域:帧数 ${capabilities.limits.minFrames}–${capabilities.limits.maxFrames}(${capabilities.limits.frameRule})· 边长倍数 ${capabilities.limits.multipleOf} · fps ${capabilities.limits.fps}`,
            `Reachability:${status.reachable ? '在' : '不在'}(${status.baseUrl});准入:${status.admission.allowed ? '放行' : `拦(${status.admission.reason})`}`,
            `本机就绪:${capabilities.localReady ? '就绪' : `未就绪(${capabilities.reasons.join('; ')})`};模型 ${H3_MODEL} · 工作流 ${capabilities.workflowId}@${capabilities.workflowHash.slice(0, 12)}`,
          ].join('\n'),
        };
      }
      if (action === 'status') {
        const promptId = str(args, 'promptId');
        const result = await h3Job(runtime, promptId);
        return { ...result, summary: `prompt ${promptId}:${result.state}${result.note === undefined ? '' : `(${result.note})`}` };
      }
      if (action !== 'run') {
        throw new VidroomError('PROJECT_INVALID', `action 只能是 capabilities / run / status(收到 ${action})`);
      }
      const request: H3Request = {
        prompt: str(args, 'prompt'),
        width: Math.trunc(Number(need(args, 'width'))),
        height: Math.trunc(Number(need(args, 'height'))),
        frames: Math.trunc(Number(need(args, 'frames'))),
        ...(optNum(args, 'fps') === undefined ? {} : { fps: optNum(args, 'fps') as number }),
        ...(optNum(args, 'seed') === undefined ? {} : { seed: optNum(args, 'seed') }),
      };
      const result = await h3Run(runtime, request);
      return {
        ...result,
        model: H3_MODEL,
        summary: `H3 跑完:${result.media.length} 个产物,实际参数 ${JSON.stringify(result.effectiveParams)},用时 ${result.elapsedMs}ms`,
      };
    },
  );

  /** 把外部拿到的素材登记进工程(参考分析/本地配音/字体都用它)。 */
  const importTool = tool(
    'vidroom_import_asset',
    `把本机一个文件登记成工程资产(算 sha256、读探针、复制进 assets/),path 参数给工程路径。`,
    {
      projectPath: PROJECT_PATH,
      sourcePath: { type: 'string', description: '本机源文件的绝对路径。' },
      kind: { type: 'string', enum: ['video', 'audio', 'image', 'font'], description: '资产类型。' },
      origin: { type: 'string', enum: ['reference', 'local', 'h3'], description: '来源,默认 local。' },
    },
    ['projectPath', 'sourcePath', 'kind'],
    REFERENCE_TIMEOUT_MS,
    async (args) => {
      const dir = projectDirOf(str(args, 'projectPath'));
      const current = readProject(dir);
      const kind = str(args, 'kind');
      const origin = optStr(args, 'origin') ?? 'local';
      const asset = await importAsset(dir, {
        sourcePath: str(args, 'sourcePath'),
        kind: kind as 'video' | 'audio' | 'image' | 'font',
        origin: origin as 'reference' | 'local' | 'h3',
        existingIds: current.assets.map((item) => item.id),
        tools: mediaTools(config),
      });
      const next = { ...current, assets: [...current.assets, asset] };
      next.revision = current.revision + 1;
      next.parentHash = projectHash(current);
      writeProject(dir, validateProject(next));
      return {
        projectPath: dir,
        asset,
        projectHash: projectHash(next),
        summary: `资产 ${asset.id} 已登记(${asset.kind} · ${asset.path} · sha256 ${asset.sha256.slice(0, 12)})`,
      };
    },
  );

  /** 手工登记一个候选(用已有素材,不再生成)。 */
  const registerCandidate = tool(
    'vidroom_candidate_add',
    `把工程里已有的一个视频资产登记成某个镜头的候选(用于手工挑选/回填),会带上配方哈希与实测参数。`,
    {
      projectPath: PROJECT_PATH,
      shotId: { type: 'string', description: '镜头 id。' },
      assetId: { type: 'string', description: '候选用的资产 id(要已在工程里)。' },
      seed: { type: 'number', description: '这条候选的种子(有就记)。' },
      select: { type: 'boolean', description: '是否同时把它设成这个镜头的选定素材。' },
    },
    ['projectPath', 'shotId', 'assetId'],
    FAST_TIMEOUT_MS,
    async (args) => {
      const dir = projectDirOf(str(args, 'projectPath'));
      const current = readProject(dir);
      const shotId = str(args, 'shotId');
      const assetId = str(args, 'assetId');
      const shot = current.shots.find((item) => item.id === shotId);
      if (shot === undefined) throw new VidroomError('PROJECT_INVALID', `工程里没有镜头 ${shotId}`);
      const asset = current.assets.find((item) => item.id === assetId);
      if (asset === undefined) throw new VidroomError('PROJECT_INVALID', `工程里没有资产 ${assetId}`);
      const probe = asset.probe;
      const id = candidateId(current.candidates.map((item) => item.id));
      const candidate = {
        id,
        shotId,
        assetId,
        recipeHash: `${asset.sha256.slice(0, 16)}`,
        ...(optNum(args, 'seed') === undefined ? {} : { seed: optNum(args, 'seed') as number }),
        actual: {
          width: probe?.width ?? 0,
          height: probe?.height ?? 0,
          fps: probe?.fps ?? { num: 24, den: 1 },
          frames: probe?.frames ?? 0,
          audio: probe?.audio ?? false,
        },
        status: 'available' as const,
      };
      // 候选 id 列表不在白名单 patch 能碰的范围里,这里直接改并写出(仍走 validateProject)。
      const next = structuredClone(current) as Project;
      const targetShot = next.shots.find((item) => item.id === shotId);
      if (targetShot === undefined) throw new VidroomError('PROJECT_INVALID', `工程里没有镜头 ${shotId}`);
      targetShot.candidateIds.push(id);
      next.candidates.push(candidate);
      if (args.select === true) targetShot.selectedCandidateId = id;
      next.revision = current.revision + 1;
      next.parentHash = projectHash(current);
      writeProject(dir, validateProject(next));
      return {
        projectPath: dir,
        candidate,
        projectHash: projectHash(next),
        summary: `候选 ${id} 已登记到 ${shotId}${args.select === true ? '(并已选定)' : ''}`,
      };
    },
  );

  const definitions = [
    reference,
    project,
    plan,
    candidates,
    assets,
    align,
    render,
    job,
    variants,
    h3,
    importTool,
    registerCandidate,
  ];
  return definitions.map((definition) => ctx.tools.register(definition));
}
