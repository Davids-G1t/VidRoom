/**
 * 工程操作的真身:工具面(`project-tools.ts`)与面板路由(`routes.ts`)都调这里。
 * 同一件事只在这里定义一次 —— 面板与聊天工具看到的数字/错误码必然一致。
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { buildAlignment, alignmentIssues, compileTimelineEvents, wordsOf } from './align.js';
import type { Config } from './config.js';
import { mediaTools } from './config.js';
import { VidroomError } from './errors.js';
import type { MediaTools, Probe } from './media.js';
import { buildPlan, type Plan, type PlanTarget } from './plan.js';
import { applyPatch, ensureDir, importAsset, nextId, projectFileOf, readProject, writeProject } from './project-io.js';
import {
  PROJECT_FILE,
  emptyProject,
  projectHash,
  projectIssues,
  validateProject,
  type Analysis,
  type AnalysisShot,
  type Asset,
  type Budget,
  type PatchOp,
  type Project,
} from './project.js';
import { RunStore, newRunId, type Receipt, type RunSummary } from './receipts.js';
import type { VidroomRuntime } from './runtime.js';

/* ------------------------------------------------------------------ *
 * 打开与视图
 * ------------------------------------------------------------------ */

/** 工程根目录:收目录或 `project.vr.json` 都能认。 */
export function projectDirOf(projectPath: string): string {
  const abs = resolve(projectPath);
  if (existsSync(abs) && statSync(abs).isDirectory()) return abs;
  if (abs.endsWith(PROJECT_FILE)) return dirname(abs);
  return abs;
}

export function openProject(projectPath: string): { dir: string; project: Project } {
  const dir = projectDirOf(projectPath);
  if (!existsSync(projectFileOf(dir))) {
    throw new VidroomError('PROJECT_NOT_FOUND', `${dir} 里没有 ${PROJECT_FILE}`);
  }
  return { dir, project: readProject(dir) };
}

export interface ProjectView {
  projectPath: string;
  projectFile: string;
  projectId: string;
  revision: number;
  projectHash: string;
  counts: Record<string, number>;
  issues: string[];
  alignmentIssues: string[];
  reference?: { assetId: string; analysisStatus: string; shots: number };
  script?: { segments: number; tokens: number };
  budget: Budget;
  output: Project['output'];
}

export function inspectProject(dir: string, project: Project): ProjectView {
  return {
    projectPath: dir,
    projectFile: projectFileOf(dir),
    projectId: project.projectId,
    revision: project.revision,
    projectHash: projectHash(project),
    counts: {
      assets: project.assets.length,
      shots: project.shots.length,
      candidates: project.candidates.length,
      selected: project.shots.filter((shot) => shot.selectedCandidateId !== undefined).length,
      alignments: project.alignments.length,
      anchors: project.anchors.length,
      captions: project.captions.length,
      effects: project.effects.length,
      variants: project.variants.length,
    },
    issues: projectIssues(project),
    alignmentIssues: alignmentIssues(project),
    ...(project.reference === undefined
      ? {}
      : {
          reference: {
            assetId: project.reference.assetId,
            analysisStatus: project.reference.analysisStatus,
            shots: project.analysis?.shots.length ?? 0,
          },
        }),
    ...(project.script === undefined
      ? {}
      : { script: { segments: project.script.segments.length, tokens: project.script.tokens.length } }),
    budget: project.budget,
    output: project.output,
  };
}

/** 面板/工具都用一行文字看工程状态。 */
export function projectSummary(project: Project): string {
  const selected = project.shots.filter((shot) => shot.selectedCandidateId !== undefined).length;
  return `工程 ${project.projectId} r${project.revision} · 哈希 ${projectHash(project).slice(0, 12)} · 镜头 ${project.shots.length}(已选定 ${selected})· 候选 ${project.candidates.length} · 资产 ${project.assets.length}`;
}

export function patchProject(
  dir: string,
  project: Project,
  options: { baseHash?: string | undefined; patch: PatchOp[] },
): {
  project: Project;
  changedPaths: string[];
  invalidatedShotIds: string[];
  selectionClearedShotIds: string[];
  alignmentRequired: boolean;
  projectHash: string;
} {
  const current = projectHash(project);
  if (options.baseHash !== undefined && options.baseHash !== current) {
    throw new VidroomError(
      'PROJECT_HASH_MISMATCH',
      `工程已经变了(现在 ${current.slice(0, 12)},收到 ${options.baseHash.slice(0, 12)});重新读一次再改`,
    );
  }
  const patched = applyPatch(project, options.patch);
  patched.project.revision = project.revision + 1;
  patched.project.parentHash = current;
  const next = validateProject(patched.project);
  writeProject(dir, next);
  return {
    project: next,
    changedPaths: patched.changedPaths,
    invalidatedShotIds: patched.invalidatedShotIds,
    selectionClearedShotIds: patched.selectionClearedShotIds,
    alignmentRequired: patched.alignmentRequired,
    projectHash: projectHash(next),
  };
}

/** 工程 id 当目录名用,只允一段安全字符 —— 不允许 `/`、`..`、空字符串。 */
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 面板「新建工程」:在 projectsRoot 下落一个空工程。 */
export function createProject(config: Config, projectId?: string): { dir: string; project: Project } {
  if (projectId !== undefined && !SAFE_PROJECT_ID.test(projectId)) {
    throw new VidroomError('PROJECT_INVALID', `工程 id 只能是一段字母数字与 ._- :${projectId}`);
  }
  const id = projectId ?? `project-${newRunId().slice(4)}`;
  const dir = join(config.projectsRoot, id);
  const root = resolve(config.projectsRoot);
  if (!resolve(dir).startsWith(`${root}${sep}`)) {
    throw new VidroomError('PROJECT_INVALID', `工程 id 越出 projectsRoot:${projectId}`);
  }
  if (existsSync(projectFileOf(dir))) {
    throw new VidroomError('PROJECT_INVALID', `${dir} 已经有工程了`);
  }
  ensureDir(dir);
  writeProject(dir, emptyProject(id));
  return { dir, project: readProject(dir) };
}

/** 列出 projectsRoot 下的工程(面板左侧列表)。 */
export function listProjects(config: Config): Array<{ dir: string; view?: ProjectView; error?: string }> {
  if (!existsSync(config.projectsRoot)) return [];
  const items: Array<{ dir: string; view?: ProjectView; error?: string }> = [];
  for (const entry of readdirSync(config.projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(config.projectsRoot, entry.name);
    if (!existsSync(projectFileOf(dir))) continue;
    try {
      items.push({ dir, view: inspectProject(dir, readProject(dir)) });
    } catch (error) {
      items.push({ dir, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return items.sort((left, right) => (left.dir < right.dir ? -1 : 1));
}

/* ------------------------------------------------------------------ *
 * 计划
 * ------------------------------------------------------------------ */

export interface PlanView extends Plan {
  frames: number;
  summary: string;
}

export async function planProject(
  dir: string,
  project: Project,
  target: PlanTarget,
  budget?: Partial<Budget>,
): Promise<PlanView> {
  const plan = await buildPlan(project, {
    dir,
    target,
    ...(budget === undefined ? {} : { budget }),
  });
  const frames = plan.newRequests.reduce((sum, request) => sum + request.frames, 0);
  return {
    ...plan,
    frames,
    summary: [
      `计划 ${plan.planHash.slice(0, 12)}(目标 ${plan.target} · 工程哈希 ${plan.projectHash.slice(0, 12)})`,
      `复用候选 ${plan.reuseCandidateIds.length} 个;新请求 ${plan.newRequests.length} 条 / ${frames} 帧`,
      plan.ready
        ? `可以跑:预计 ${plan.estimates.wallSeconds?.low ?? '?'}–${plan.estimates.wallSeconds?.high ?? '?'} 秒,占盘约 ${plan.estimates.diskBytes ?? '?'} 字节`
        : `先别跑,缺:${plan.blockers.join('; ')}`,
    ].join('\n'),
  };
}

/* ------------------------------------------------------------------ *
 * 候选与资产
 * ------------------------------------------------------------------ */

export function listCandidates(
  project: Project,
  options: { shotId?: string | undefined; cursor?: string | undefined; limit?: number | undefined },
): { total: number; items: Array<Record<string, unknown>>; nextCursor?: string } {
  const limit = options.limit === undefined ? 20 : Math.min(100, Math.max(1, Math.trunc(options.limit)));
  const all = project.candidates
    .filter((candidate) => options.shotId === undefined || candidate.shotId === options.shotId)
    .sort((left, right) => (left.id < right.id ? -1 : 1));
  const start = options.cursor === undefined ? 0 : all.findIndex((candidate) => candidate.id === options.cursor) + 1;
  const page = all.slice(start, start + limit);
  const next = all[start + limit];
  return {
    total: all.length,
    items: page.map((candidate) => ({
      ...candidate,
      selected: project.shots.find((shot) => shot.id === candidate.shotId)?.selectedCandidateId === candidate.id,
    })),
    ...(next === undefined ? {} : { nextCursor: next.id }),
  };
}

export function assetView(dir: string, asset: Asset): Asset & { absolutePath: string; missing: boolean } {
  const absolutePath = resolve(dir, asset.path);
  return { ...asset, absolutePath, missing: !existsSync(absolutePath) };
}

export function listAssets(
  dir: string,
  project: Project,
  options: { cursor?: string | undefined; limit?: number | undefined },
): { total: number; items: Array<ReturnType<typeof assetView>>; nextCursor?: string } {
  const limit = options.limit === undefined ? 20 : Math.min(100, Math.max(1, Math.trunc(options.limit)));
  const start = options.cursor === undefined ? 0 : project.assets.findIndex((item) => item.id === options.cursor) + 1;
  const page = project.assets.slice(start, start + limit);
  const next = project.assets[start + limit];
  return {
    total: project.assets.length,
    items: page.map((asset) => assetView(dir, asset)),
    ...(next === undefined ? {} : { nextCursor: next.id }),
  };
}

/** 工程里引用了但盘上没有的资产(缺件报错用)。 */
export function missingAssets(project: Project, dir: string): string[] {
  return project.assets.filter((asset) => !existsSync(resolve(dir, asset.path))).map((asset) => asset.id);
}

/* ------------------------------------------------------------------ *
 * 参考:登记 + 切镜候选
 * ------------------------------------------------------------------ */

/** 用 ffmpeg 的 scene 滤镜找切点;读不到就如实退回「整条一个镜头」。 */
export async function detectCutFrames(
  file: string,
  tools: MediaTools,
  probe: Probe,
): Promise<{ frames: number[]; method: 'scene-detect' | 'whole-clip' }> {
  const listPath = join(tmpdir(), `vidroom-scene-${process.pid}-${Date.now()}.txt`);
  try {
    const { runFfmpeg } = await import('./media.js');
    await runFfmpeg(
      ['-i', file, '-an', '-vf', `select='gt(scene,0.35)',metadata=print:file=${listPath}`, '-f', 'null', '-'],
      tools,
    );
    const raw = existsSync(listPath) ? readFileSync(listPath, 'utf8') : '';
    const seconds = [...raw.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1]));
    const frames = [
      ...new Set(
        seconds.map((value) => Math.round((value * probe.fps.num) / probe.fps.den)).filter((frame) => frame > 0),
      ),
    ].sort((left, right) => left - right);
    return { frames, method: frames.length > 0 ? 'scene-detect' : 'whole-clip' };
  } catch {
    return { frames: [], method: 'whole-clip' };
  } finally {
    rmSync(listPath, { force: true });
  }
}

/** 切点 → 参考镜头候选(`analysis.shots`)。 */
export function analysisShots(probe: Probe, cuts: number[]): AnalysisShot[] {
  const total =
    probe.frames ?? Math.max(1, Math.round(((probe.durationSeconds ?? 0) * probe.fps.num) / probe.fps.den));
  const bounds = [0, ...cuts.filter((frame) => frame < total), total];
  const shots: AnalysisShot[] = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const startFrame = bounds[index] ?? 0;
    const endFrame = bounds[index + 1] ?? total;
    if (endFrame <= startFrame) continue;
    shots.push({
      id: `refshot-${index + 1}`,
      startFrame,
      endFrame,
      description: `切镜候选 ${index + 1}(自动检测,待人工校订)`,
      // 参考片上的字幕文字看不了(不做 OCR),留占位等人工填 —— 不能空,空就不是合法工程。
      captionText: '待校订',
      cutStyle: index === 0 ? 'open' : 'cut',
    });
  }
  return shots;
}

export interface ReferenceInput {
  /** 本机文件;只有链接时给不出来 —— 那就报 REFERENCE_LOCAL_REQUIRED。 */
  localPath?: string | undefined;
  projectPath?: string | undefined;
  referenceUrl?: string | undefined;
  annotations?: { captionStyle?: Analysis['captionStyle']; voice?: Analysis['voice'] } | undefined;
}

export interface ReferenceView {
  projectPath: string;
  projectFile: string;
  projectHash: string;
  assetId: string;
  probe: Probe;
  method: 'scene-detect' | 'whole-clip';
  shotCandidates: Array<{ id: string; startFrame: number; endFrame: number; cutStyle: string }>;
  analysisStatus: 'draft';
  requiredAnnotations: string[];
  summary: string;
}

const DEFAULT_CAPTION_STYLE: Analysis['captionStyle'] = {
  font: 'Noto Sans CJK SC',
  size: 48,
  color: '#FFFFFF',
  position: 'bottom',
  maxCharsPerLine: 14,
};

const REQUIRED_ANNOTATIONS = [
  'analysis.shots[].description / captionText:每个切镜候选要写清画面与置词',
  'analysis.rhythm:每个镜头的卡点帧',
  'analysis.voice:人声方向(原片声音只作参考,还是重录)',
  'analysis.captionStyle:字号/颜色/位置以本机字体为准',
];

/** 本地参考视频 → 资产 + 切镜候选(只读本机文件,不外发、不下载)。 */
export async function registerReference(
  config: Config,
  input: ReferenceInput,
): Promise<ReferenceView> {
  if (input.localPath === undefined || input.localPath.trim() === '') {
    throw new VidroomError(
      'REFERENCE_LOCAL_REQUIRED',
      '第 2 批只吃本机文件:把参考片存到本机再把路径传进来(链接只当来源文字记,不去下载)。',
    );
  }
  if (input.referenceUrl !== undefined) assertRecordedUrl(input.referenceUrl);
  const localPath = resolve(input.localPath);
  if (!existsSync(localPath) || !statSync(localPath).isFile()) {
    throw new VidroomError('REFERENCE_LOCAL_REQUIRED', `本机没有这个文件:${localPath}`);
  }
  const tools = mediaTools(config);

  let dir: string;
  let project: Project;
  if (input.projectPath !== undefined && existsSync(projectFileOf(projectDirOf(input.projectPath)))) {
    const opened = openProject(input.projectPath);
    dir = opened.dir;
    project = opened.project;
  } else {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const projectId = `ref-${stamp}`;
    dir = input.projectPath === undefined ? join(config.projectsRoot, projectId) : projectDirOf(input.projectPath);
    ensureDir(dir);
    project = emptyProject(projectId);
  }

  const asset = await importAsset(dir, {
    sourcePath: localPath,
    kind: 'video',
    origin: 'reference',
    existingIds: project.assets.map((item) => item.id),
    tools,
  });
  if (asset.probe === undefined) {
    throw new VidroomError('MEDIA_TOOL_MISSING', `读不出 ${localPath} 的视频参数(检查 ffprobe),做不了参考分析`);
  }
  const detection = await detectCutFrames(resolve(dir, asset.path), tools, asset.probe);
  const shots = analysisShots(asset.probe, detection.frames);

  project.assets.push(asset);
  project.reference = {
    assetId: asset.id,
    ...(input.referenceUrl === undefined ? {} : { referenceUrl: input.referenceUrl }),
    probe: asset.probe,
    analysisStatus: 'draft',
  };
  project.analysis = {
    shots,
    rhythm: [],
    structure: [],
    captionStyle: input.annotations?.captionStyle ?? DEFAULT_CAPTION_STYLE,
    voice: input.annotations?.voice ?? { description: '待人工校订', observedShotIds: [], status: 'draft' },
    evidence: [
      { field: 'reference.probe', method: 'probe' },
      ...shots.map((shot) => ({
        field: 'analysis.shots',
        shotId: shot.id,
        frame: shot.startFrame,
        method: 'probe' as const,
      })),
    ],
  };
  project.revision += 1;
  writeProject(dir, validateProject(project));

  return {
    projectPath: dir,
    projectFile: projectFileOf(dir),
    projectHash: projectHash(project),
    assetId: asset.id,
    probe: asset.probe,
    method: detection.method,
    shotCandidates: shots.map((shot) => ({
      id: shot.id,
      startFrame: shot.startFrame,
      endFrame: shot.endFrame,
      cutStyle: shot.cutStyle,
    })),
    analysisStatus: 'draft',
    requiredAnnotations: REQUIRED_ANNOTATIONS,
    summary: [
      `参考已登记:${asset.id}(${asset.probe.width}x${asset.probe.height} · ${asset.probe.frames ?? '?'} 帧 · 音轨${asset.probe.audio ? '有' : '无'})`,
      `切镜候选 ${shots.length} 条(${detection.method === 'scene-detect' ? '本地 scene 检测' : '没检出切点,整条当一个镜头'});分析状态 = draft,人工校订后才算数`,
      `工程:${projectFileOf(dir)}`,
    ].join('\n'),
  };
}

/** 参考来源 URL 只做记录,但外网地址一律拒(本插件不外发)。 */
export function assertRecordedUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VidroomError('PROJECT_INVALID', `referenceUrl 不是合法 URL:${url}`);
  }
  const host = parsed.hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new VidroomError('LOCAL_ONLY', `只收本机地址,拒了 ${parsed.origin},也不去访问它`);
  }
}

/* ------------------------------------------------------------------ *
 * 词对齐
 * ------------------------------------------------------------------ */

export interface AlignView {
  projectPath: string;
  revision: number;
  projectHash: string;
  segmentId: string;
  words: number;
  compiledCaptions: number;
  compiledEffects: number;
  unresolvedAnchors: string[];
  alignment: ReturnType<typeof buildAlignment>;
  summary: string;
}

export function alignSegment(
  dir: string,
  project: Project,
  input: {
    segmentId: string;
    assetId: string;
    audioHash: string;
    scriptHash: string;
    wordWindows: Array<{ tokenId: string; startFrame: number; endFrame: number }>;
  },
): AlignView {
  const alignment = buildAlignment(project, input);
  const kept = project.alignments.filter((item) => item.segmentId !== alignment.segmentId);
  const next: Project = { ...project, alignments: [...kept, alignment] };
  const audio = next.audio ?? { mode: 'local' as const, assetIds: [], alignmentStatus: 'pending' as const };
  // 静音工程一旦绑上录音就是要用它:模式跟着改成 local。
  // (不改的话合成会当静音,资产白登记 —— 这条在返回值 summary 里明说,不默默改。)
  const switched = audio.mode === 'silent';
  next.audio = {
    ...audio,
    mode: switched ? ('local' as const) : audio.mode,
    assetIds: audio.assetIds.includes(alignment.assetId) ? audio.assetIds : [...audio.assetIds, alignment.assetId],
    alignmentStatus: 'confirmed',
  };
  next.revision = project.revision + 1;
  next.parentHash = projectHash(project);
  writeProject(dir, validateProject(next));
  const compiled = compileTimelineEvents(next);
  const unresolved = alignmentIssues(next);
  return {
    projectPath: dir,
    revision: next.revision,
    projectHash: projectHash(next),
    segmentId: alignment.segmentId,
    words: wordsOf(next, alignment.segmentId).length,
    compiledCaptions: compiled.captions.length,
    compiledEffects: compiled.effects.length,
    unresolvedAnchors: unresolved,
    alignment,
    summary: [
      `段 ${alignment.segmentId} 对齐已写:${alignment.words.length} 个词`,
    ...(switched ? ['音轨模式:silent → local(这一段绑了录音,合成会用它)'] : []),
      `编译出字幕 ${compiled.captions.length} 条、效果 ${compiled.effects.length} 个`,
      unresolved.length === 0 ? '锚点都落实了' : `还有 ${unresolved.length} 处没落实:${unresolved.join('; ')}`,
    ].join('\n'),
  };
}

/* ------------------------------------------------------------------ *
 * 回执
 * ------------------------------------------------------------------ */

export interface JobView {
  projectPath: string;
  runId?: string;
  receipt?: Receipt;
  runs?: RunSummary[];
  summary: string;
}

export function jobView(dir: string, runId?: string, limit = 10): JobView {
  const store = new RunStore(dir);
  if (runId === undefined) {
    const runs = store.list().slice(-Math.max(1, Math.trunc(limit))).reverse();
    return {
      projectPath: dir,
      runs,
      summary:
        runs.length === 0
          ? '这个工程还没有 run'
          : `最近 ${runs.length} 条 run:${runs.map((item) => `${item.runId}(${item.mode}/${item.state})`).join(', ')}`,
    };
  }
  const receipt = store.read(runId);
  if (receipt === undefined) throw new VidroomError('RUN_NOT_FOUND', `这个工程里没有 run ${runId}`);
  return {
    projectPath: dir,
    runId,
    receipt,
    summary: [
      `${receipt.runId}:${receipt.mode} / ${receipt.state}`,
      `镜头 ${receipt.shots.length}(成 ${receipt.shots.filter((shot) => shot.state === 'succeeded').length})· 产物 ${receipt.outputs.length}`,
      receipt.error === undefined ? '无错误' : `错误:${receipt.code ?? ''} ${receipt.error}`,
    ].join('\n'),
  };
}

/** 同一工程同时只跑一条 run(设计页的 ALREADY_RUNNING)。 */
const IN_FLIGHT = new Set<string>();

export function markRunning(dir: string): () => void {
  const key = resolve(dir);
  if (IN_FLIGHT.has(key)) {
    throw new VidroomError('ALREADY_RUNNING', `${key} 上还有一条 run 在跑,等它结束再开`);
  }
  IN_FLIGHT.add(key);
  return () => IN_FLIGHT.delete(key);
}

/** 面板点渲染:立刻返回,真正跑在后台,进度靠 jobView 轮询。 */
export async function startRender(
  runtime: VidroomRuntime,
  request: {
    dir: string;
    mode: 'compose' | 'generate-missing';
    expectedProjectHash?: string | undefined;
    /** 计划哈希:必填 —— 没冻结的计划不开工。 */
    planHash: string;
    budget?: Partial<Budget> | undefined;
  },
): Promise<{ runId: string; mode: string }> {
  const { renderProject } = await import('./render.js');
  const project = readProject(request.dir);
  const release = markRunning(request.dir);
  try {
    const result = await renderProject(runtime, project, {
      dir: request.dir,
      target: request.mode === 'compose' ? 'final' : 'candidates',
      ...(request.expectedProjectHash === undefined ? {} : { expectedProjectHash: request.expectedProjectHash }),
      planHash: request.planHash,
      ...(request.budget === undefined ? {} : { budget: request.budget }),
    });
    return { runId: result.runId, mode: request.mode };
  } finally {
    release();
  }
}

/** 候选 id 生成器(面板手工登记候选时用,和 render 里同一套前缀)。 */
export function candidateId(existing: Iterable<string>): string {
  return nextId('cand', existing);
}
