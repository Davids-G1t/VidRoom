/**
 * 工程文件:`vr.project/1`(UTF-8 JSON)。
 *
 * 这一层只做三件事:定义 schema、验 schema、算哈希与安全路径。落盘与导入在
 * `project-io.ts`,计划在 `plan.ts`,合成在 `compose.ts`。
 *
 * 工程文件**不是**一份提示词、也不是一份 ComfyUI 图:它是可重跑的创作来源。
 * 素材留在同目录 `assets/`,每次运行在 `runs/<runId>/` 留快照、计划与回执。
 */

import { createHash } from 'node:crypto';
import { VidroomError } from './errors.js';
import type { Fps, Probe } from './media.js';

export const SCHEMA_VERSION = 'vr.project/1';

/** 本批唯一的生成模型。 */
export const H3_MODEL = 'MiniMax-H3';

/** 交付定义里写进容器的标注,与第 1 批一致(不因“自用”删掉标名)。 */
export const OUTPUT_METADATA = 'AI-generated with MiniMax H3';

export interface Policy {
  use: 'personal';
  distribution: 'none';
  commercial: false;
  network: 'loopback-only';
  models: string[];
}

export interface Reference {
  assetId: string;
  /** 只作为来源文字保存;永远不当作资产地址,也不去解析/下载。 */
  referenceUrl?: string;
  probe: Probe;
  analysisStatus: 'draft' | 'confirmed';
}

export interface AnalysisShot {
  id: string;
  startFrame: number;
  endFrame: number;
  description: string;
  captionText: string;
  cutStyle: string;
}

export interface RhythmPoint {
  shotId: string;
  beatFrame: number;
  pauseFrames: number;
}

export interface StructureBeat {
  id: string;
  role: string;
  shotIds: string[];
}

export interface CaptionStyle {
  font: string;
  size: number;
  color: string;
  position: string;
  maxCharsPerLine: number;
}

export interface VoiceDirection {
  description: string;
  observedShotIds: string[];
  status: 'draft' | 'confirmed';
}

export interface Evidence {
  field: string;
  shotId?: string;
  frame?: number;
  method: 'manual' | 'probe';
}

export interface Analysis {
  shots: AnalysisShot[];
  rhythm: RhythmPoint[];
  structure: StructureBeat[];
  captionStyle: CaptionStyle;
  voice: VoiceDirection;
  evidence: Evidence[];
}

export interface ScriptToken {
  id: string;
  segmentId: string;
  /** 出声用的词(音轨里念的)。 */
  speech: string;
  /** 上屏用的写法(标点附前词,显示可以与 speech 不同)。 */
  display: string;
  /** 在 `segment.text` 里的半开区间 `[start, end)`。 */
  charRange: [number, number];
}

export interface ScriptSegment {
  id: string;
  role: string;
  speakerId?: string;
  text: string;
  tokenIds: string[];
}

export interface Script {
  language: 'zh';
  segments: ScriptSegment[];
  tokens: ScriptToken[];
}

export type AssetKind = 'video' | 'audio' | 'image' | 'font' | 'workflow';

export interface Asset {
  id: string;
  kind: AssetKind;
  /** 相对工程根的路径,只许是 `assets/` 下的普通文件。 */
  path: string;
  sha256: string;
  origin: 'reference' | 'local' | 'h3';
  probe?: Probe;
  sourceRunId?: string;
}

export interface WorkflowLock {
  id: string;
  path: string;
  sha256: string;
  sourceCommit?: string;
}

export interface Locks {
  pluginCommit?: string;
  adapterVersion: string;
  workflow?: WorkflowLock;
  models: Array<{ file: string; sha256: string }>;
  comfyuiVersion?: string;
  ffmpegVersion?: string;
  fontAssetIds: string[];
  /** 没测到的锁(例如模型哈希太大本轮没算),如实记下来 —— 不凭模型名补造。 */
  deferred: string[];
}

export interface Generation {
  model: typeof H3_MODEL;
  prompt: string;
  seed?: number;
  requestedSeconds: number;
  width: number;
  height: number;
  fps: Fps;
  steps?: number;
  sampler?: string;
  scheduler?: string;
  workflowHash?: string;
}

export interface ShotEdit {
  inFrame: number;
  outFrame: number;
  /** 变速:分子/分母 = 倍数(2/1 是两倍速)。 */
  speed: Fps;
  audio: 'keep' | 'mute';
}

export interface Shot {
  id: string;
  referenceShotId?: string;
  segmentId?: string;
  order: number;
  generation: Generation;
  candidateIds: string[];
  selectedCandidateId?: string;
  edit: ShotEdit;
}

export interface Candidate {
  id: string;
  shotId: string;
  assetId: string;
  recipeHash: string;
  seed?: number;
  actual: { width: number; height: number; fps: Fps; frames: number; audio: boolean };
  status: 'available' | 'missing' | 'rejected';
}

export interface AudioTrack {
  mode: 'h3' | 'local' | 'silent';
  assetIds: string[];
  voiceDirection?: string;
  alignmentStatus: 'pending' | 'confirmed';
}

export interface Alignment {
  segmentId: string;
  assetId: string;
  audioHash: string;
  scriptHash: string;
  fps: Fps;
  method: 'manual';
  status: 'confirmed';
  /** 段内半开区间 `[startFrame, endFrame)`,按词升序。 */
  words: Array<{ tokenId: string; startFrame: number; endFrame: number }>;
}

export interface WordAnchor {
  id: string;
  kind: 'word';
  tokenId: string;
  edge: 'start' | 'end';
  offsetFrames: number;
}

/** 无语音片替用的镜头锚(整数帧)。它**不是**词锚,类型上就分开。 */
export interface ShotAnchor {
  id: string;
  kind: 'shot';
  shotId: string;
  frame: number;
}

export type Anchor = WordAnchor | ShotAnchor;

export interface Caption {
  id: string;
  fromAnchor: string;
  toAnchor: string;
  tokenIds: string[];
  styleId: string;
}

export interface Effect {
  id: string;
  atAnchor: string;
  durationFrames: number;
  type: 'highlight' | 'title-pop';
  params: Record<string, unknown>;
}

export interface Style {
  id: string;
  fontAssetId?: string;
  font?: string;
  size: number;
  color: string;
  position: string;
}

export interface Placement {
  shotId: string;
  startFrame: number;
  durationFrames: number;
}

export interface Timeline {
  fps: Fps;
  width: number;
  height: number;
  placements: Placement[];
  totalFrames: number;
}

export interface PatchOp {
  op: 'replace' | 'add' | 'remove';
  path: string;
  value?: unknown;
}

export interface Variant {
  id: string;
  baseHash: string;
  patch: PatchOp[];
  seedByShot?: Record<string, number>;
}

export interface Budget {
  maxVariants: number;
  maxNewCandidates: number;
  maxDiskBytes: number;
  maxWallSeconds: number;
  gpuWorkers: 1;
}

export interface OutputSpec {
  container: 'mp4';
  path: string;
  metadata: string;
}

export interface Project {
  schemaVersion: typeof SCHEMA_VERSION;
  projectId: string;
  revision: number;
  parentHash?: string;
  policy: Policy;
  reference?: Reference;
  analysis?: Analysis;
  script?: Script;
  assets: Asset[];
  locks?: Locks;
  shots: Shot[];
  candidates: Candidate[];
  audio?: AudioTrack;
  alignments: Alignment[];
  anchors: Anchor[];
  captions: Caption[];
  effects: Effect[];
  styles: Style[];
  timeline?: Timeline;
  variants: Variant[];
  budget: Budget;
  output: OutputSpec;
}

/** 工程文件的名字与默认形状。 */
export const PROJECT_FILE = 'project.vr.json';

/** 默认预算:预算面一律显式,不靠隐式默认(设计页的 `budget` 五项)。 */
export function defaultBudget(overrides: Partial<Budget> = {}): Budget {
  return {
    maxVariants: 3,
    maxNewCandidates: 6,
    maxDiskBytes: 8 * 1024 ** 3,
    maxWallSeconds: 3_600,
    gpuWorkers: 1,
    ...overrides,
  };
}

/** 新工程的骨架(只有边界与空集合,创作字段等人工/模型填)。 */
export function emptyProject(projectId: string, budget: Partial<Budget> = {}): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    revision: 1,
    policy: {
      use: 'personal',
      distribution: 'none',
      commercial: false,
      network: 'loopback-only',
      models: [H3_MODEL],
    },
    assets: [],
    shots: [],
    candidates: [],
    alignments: [],
    anchors: [],
    captions: [],
    effects: [],
    styles: [],
    variants: [],
    budget: defaultBudget(budget),
    output: { container: 'mp4', path: 'runs/<runId>/final.mp4', metadata: OUTPUT_METADATA },
  };
}

/** 稳定 JSON:键排序、无空白。哈希与快照都走它。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]));
}

export function sha256Of(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 整个工程的哈希(乐观并发与失效判定都用它)。 */
export function projectHash(project: Project): string {
  return sha256Of(canonicalJson(project));
}

/** 文案哈希:改字就变,标点/换行也算 —— 对齐靠它失效。 */
export function scriptHash(script: Script | undefined): string {
  return sha256Of(canonicalJson(script ?? null));
}

/** 一句生成请求的配方哈希:同配方可去重,不重复投。 */
export function recipeHashOf(input: {
  prompt: string;
  seed?: number;
  width: number;
  height: number;
  frames: number;
  fps: Fps;
  workflowHash?: string;
}): string {
  return sha256Of(canonicalJson(input));
}

/* ------------------------------------------------------------------ *
 * 路径安全:工程内只许相对路径,不许 URL / 绝对路径 / `..` / 符号链接越界
 * ------------------------------------------------------------------ */

const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** 工程内的相对路径必须长这样;否则抛 `PROJECT_INVALID`。 */
export function assertRelativePath(path: string, what = 'path'): void {
  if (path.trim() === '') throw new VidroomError('PROJECT_INVALID', `${what} 不能是空串`);
  if (URL_LIKE.test(path)) {
    throw new VidroomError('PROJECT_INVALID', `${what} 不许是 URL(${path});本批只用本地文件`);
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new VidroomError('PROJECT_INVALID', `${what} 不许是绝对路径(${path})`);
  }
  if (path.includes('\\')) throw new VidroomError('PROJECT_INVALID', `${what} 不许用反斜杠(${path})`);
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new VidroomError('PROJECT_INVALID', `${what} 不许空段、「.」或「..」(${path})`);
    }
  }
}

/** 只许回环地址的网络面(设计页的红线:网络 `loopback-only`)。 */
export function assertLoopbackUrl(url: string, what = 'url'): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VidroomError('LOCAL_ONLY', `${what} 读不成 URL:${url}`);
  }
  if (parsed.protocol !== 'http:') {
    throw new VidroomError('LOCAL_ONLY', `${what} 只许 http 回环地址,收到 ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (!loopback) {
    throw new VidroomError('LOCAL_ONLY', `${what} 只许回环地址(拿到 ${host});非本机地址一律拒绝`);
  }
}

/* ------------------------------------------------------------------ *
 * schema 校验:不合法就抛错,不静默跳过、不猜
 * ------------------------------------------------------------------ */

function fail(where: string, message: string): never {
  throw new VidroomError('PROJECT_INVALID', `工程不合法(${where}):${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(where, '要是个对象');
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(where, '要是个数组');
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(where, '要是非空字符串');
  return value;
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, '要是有限数');
  return value;
}

function asInt(value: unknown, where: string): number {
  const number = asNumber(value, where);
  if (!Number.isInteger(number)) fail(where, '要是整数');
  return number;
}

function asBool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') fail(where, '要是布尔');
  return value;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  const text = asString(value, where);
  if (!allowed.includes(text as T)) fail(where, `只许 ${allowed.join(' / ')},收到 ${text}`);
  return text as T;
}

function asFps(value: unknown, where: string): Fps {
  const record = asRecord(value, where);
  const num = asInt(record.num, `${where}.num`);
  const den = asInt(record.den, `${where}.den`);
  if (num <= 0 || den <= 0) fail(where, '分子分母都要是正数');
  return { num, den };
}

function noUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(where, `不认识的字段 ${key}`);
  }
}

const SHA256 = /^[0-9a-f]{64}$/;

function asSha(value: unknown, where: string): string {
  const text = asString(value, where);
  if (!SHA256.test(text)) fail(where, '要是 sha256 的 64 位小写十六进制');
  return text;
}

function uniqueIds(items: Array<{ id: string }>, where: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) fail(where, `id 重复:${item.id}`);
    seen.add(item.id);
  }
}

/** 验一份工程。通过就返回它(类型收窄),不通过抛 `PROJECT_INVALID`。 */
export function validateProject(value: unknown): Project {
  const project = asRecord(value, 'project');
  noUnknownKeys(
    project,
    [
      'schemaVersion',
      'projectId',
      'revision',
      'parentHash',
      'policy',
      'reference',
      'analysis',
      'script',
      'assets',
      'locks',
      'shots',
      'candidates',
      'audio',
      'alignments',
      'anchors',
      'captions',
      'effects',
      'styles',
      'timeline',
      'variants',
      'budget',
      'output',
    ],
    'project',
  );
  if (project.schemaVersion !== SCHEMA_VERSION) {
    fail('schemaVersion', `只认 ${SCHEMA_VERSION},收到 ${String(project.schemaVersion)}`);
  }
  const projectId = asString(project.projectId, 'projectId');
  const revision = asInt(project.revision, 'revision');
  if (revision < 1) fail('revision', '要从 1 起');
  if (project.parentHash !== undefined) asSha(project.parentHash, 'parentHash');

  const policy = asRecord(project.policy, 'policy');
  noUnknownKeys(policy, ['use', 'distribution', 'commercial', 'network', 'models'], 'policy');
  if (policy.use !== 'personal') fail('policy.use', '本批只许 personal');
  if (policy.distribution !== 'none') fail('policy.distribution', '本批只许 none(不传播)');
  if (asBool(policy.commercial, 'policy.commercial') !== false) fail('policy.commercial', '本批只许 false(不商用)');
  if (policy.network !== 'loopback-only') fail('policy.network', '本批只许 loopback-only');
  const models = asArray(policy.models, 'policy.models').map((item, index) =>
    asString(item, `policy.models[${index}]`),
  );
  if (!models.includes(H3_MODEL)) fail('policy.models', `要含 ${H3_MODEL}`);

  const assets = asArray(project.assets, 'assets').map((item, index) => {
    const where = `assets[${index}]`;
    const record = asRecord(item, where);
    noUnknownKeys(record, ['id', 'kind', 'path', 'sha256', 'origin', 'probe', 'sourceRunId'], where);
    const path = asString(record.path, `${where}.path`);
    assertRelativePath(path, `${where}.path`);
    return {
      id: asString(record.id, `${where}.id`),
      kind: asEnum(record.kind, ['video', 'audio', 'image', 'font', 'workflow'] as const, `${where}.kind`),
      path,
      sha256: asSha(record.sha256, `${where}.sha256`),
      origin: asEnum(record.origin, ['reference', 'local', 'h3'] as const, `${where}.origin`),
      ...(record.probe === undefined ? {} : { probe: asProbe(record.probe, `${where}.probe`) }),
      ...(record.sourceRunId === undefined ? {} : { sourceRunId: asString(record.sourceRunId, `${where}.sourceRunId`) }),
    } satisfies Asset;
  });
  uniqueIds(assets, 'assets');
  const assetIds = new Set(assets.map((asset) => asset.id));

  const candidates = asArray(project.candidates, 'candidates').map((item, index) => {
    const where = `candidates[${index}]`;
    const record = asRecord(item, where);
    noUnknownKeys(record, ['id', 'shotId', 'assetId', 'recipeHash', 'seed', 'actual', 'status'], where);
    const assetId = asString(record.assetId, `${where}.assetId`);
    if (!assetIds.has(assetId)) fail(`${where}.assetId`, `没有这个资产:${assetId}`);
    const actual = asRecord(record.actual, `${where}.actual`);
    noUnknownKeys(actual, ['width', 'height', 'fps', 'frames', 'audio'], `${where}.actual`);
    return {
      id: asString(record.id, `${where}.id`),
      shotId: asString(record.shotId, `${where}.shotId`),
      assetId,
      recipeHash: asString(record.recipeHash, `${where}.recipeHash`),
      ...(record.seed === undefined ? {} : { seed: asInt(record.seed, `${where}.seed`) }),
      actual: {
        width: asInt(actual.width, `${where}.actual.width`),
        height: asInt(actual.height, `${where}.actual.height`),
        fps: asFps(actual.fps, `${where}.actual.fps`),
        frames: asInt(actual.frames, `${where}.actual.frames`),
        audio: asBool(actual.audio, `${where}.actual.audio`),
      },
      status: asEnum(record.status, ['available', 'missing', 'rejected'] as const, `${where}.status`),
    } satisfies Candidate;
  });
  uniqueIds(candidates, 'candidates');
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));

  const shots = asArray(project.shots, 'shots').map((item, index) => {
    const where = `shots[${index}]`;
    const record = asRecord(item, where);
    noUnknownKeys(
      record,
      ['id', 'referenceShotId', 'segmentId', 'order', 'generation', 'candidateIds', 'selectedCandidateId', 'edit'],
      where,
    );
    const generation = asRecord(record.generation, `${where}.generation`);
    noUnknownKeys(
      generation,
      ['model', 'prompt', 'seed', 'requestedSeconds', 'width', 'height', 'fps', 'steps', 'sampler', 'scheduler', 'workflowHash'],
      `${where}.generation`,
    );
    if (generation.model !== H3_MODEL) fail(`${where}.generation.model`, `本批只许 ${H3_MODEL}`);
    const width = asInt(generation.width, `${where}.generation.width`);
    const height = asInt(generation.height, `${where}.generation.height`);
    if (width % 32 !== 0 || height % 32 !== 0) {
      fail(`${where}.generation`, `宽高要对齐 32 的倍数(收到 ${width}x${height})`);
    }
    const edit = asRecord(record.edit, `${where}.edit`);
    noUnknownKeys(edit, ['inFrame', 'outFrame', 'speed', 'audio'], `${where}.edit`);
    const inFrame = asInt(edit.inFrame, `${where}.edit.inFrame`);
    const outFrame = asInt(edit.outFrame, `${where}.edit.outFrame`);
    if (outFrame <= inFrame) fail(`${where}.edit`, `outFrame(${outFrame}) 要大于 inFrame(${inFrame})`);
    const own = asArray(record.candidateIds, `${where}.candidateIds`).map((id, position) => {
      const text = asString(id, `${where}.candidateIds[${position}]`);
      if (!candidateIds.has(text)) fail(`${where}.candidateIds[${position}]`, `没有这个候选:${text}`);
      return text;
    });
    const selected = record.selectedCandidateId;
    if (selected !== undefined) {
      const text = asString(selected, `${where}.selectedCandidateId`);
      if (!own.includes(text)) fail(`${where}.selectedCandidateId`, `${text} 不在这个镜头的候选里`);
    }
    return {
      id: asString(record.id, `${where}.id`),
      ...(record.referenceShotId === undefined
        ? {}
        : { referenceShotId: asString(record.referenceShotId, `${where}.referenceShotId`) }),
      ...(record.segmentId === undefined ? {} : { segmentId: asString(record.segmentId, `${where}.segmentId`) }),
      order: asInt(record.order, `${where}.order`),
      generation: {
        model: H3_MODEL,
        prompt: asString(generation.prompt, `${where}.generation.prompt`),
        ...(generation.seed === undefined ? {} : { seed: asInt(generation.seed, `${where}.generation.seed`) }),
        requestedSeconds: asNumber(generation.requestedSeconds, `${where}.generation.requestedSeconds`),
        width,
        height,
        fps: asFps(generation.fps, `${where}.generation.fps`),
        ...(generation.steps === undefined ? {} : { steps: asInt(generation.steps, `${where}.generation.steps`) }),
        ...(generation.sampler === undefined ? {} : { sampler: asString(generation.sampler, `${where}.generation.sampler`) }),
        ...(generation.scheduler === undefined
          ? {}
          : { scheduler: asString(generation.scheduler, `${where}.generation.scheduler`) }),
        ...(generation.workflowHash === undefined
          ? {}
          : { workflowHash: asString(generation.workflowHash, `${where}.generation.workflowHash`) }),
      },
      candidateIds: own,
      ...(selected === undefined ? {} : { selectedCandidateId: selected as string }),
      edit: {
        inFrame,
        outFrame,
        speed: asFps(edit.speed, `${where}.edit.speed`),
        audio: asEnum(edit.audio, ['keep', 'mute'] as const, `${where}.edit.audio`),
      },
    } satisfies Shot;
  });
  uniqueIds(shots, 'shots');
  const shotIds = new Set(shots.map((shot) => shot.id));
  for (const candidate of candidates) {
    if (!shotIds.has(candidate.shotId)) fail('candidates', `${candidate.id} 指向不存在的镜头 ${candidate.shotId}`);
  }

  const script = project.script === undefined ? undefined : validateScript(project.script);
  const tokenIds = new Set((script?.tokens ?? []).map((token) => token.id));
  const segmentIds = new Set((script?.segments ?? []).map((segment) => segment.id));
  for (const shot of shots) {
    if (shot.segmentId !== undefined && !segmentIds.has(shot.segmentId)) {
      fail('shots', `${shot.id}.segmentId 指向不存在的段 ${shot.segmentId}`);
    }
  }

  const anchors = asArray(project.anchors, 'anchors').map((item, index) => validateAnchor(item, index, tokenIds, shotIds));
  uniqueIds(anchors, 'anchors');
  const anchorIds = new Set(anchors.map((anchor) => anchor.id));

  const styles = asArray(project.styles, 'styles').map((item, index) => {
    const where = `styles[${index}]`;
    const record = asRecord(item, where);
    noUnknownKeys(record, ['id', 'fontAssetId', 'font', 'size', 'color', 'position'], where);
    if (record.fontAssetId !== undefined) {
      const fontAssetId = asString(record.fontAssetId, `${where}.fontAssetId`);
      if (!assetIds.has(fontAssetId)) fail(`${where}.fontAssetId`, `没有这个字体资产:${fontAssetId}`);
    }
    return {
      id: asString(record.id, `${where}.id`),
      ...(record.fontAssetId === undefined
        ? {}
        : { fontAssetId: asString(record.fontAssetId, `${where}.fontAssetId`) }),
      ...(record.font === undefined ? {} : { font: asString(record.font, `${where}.font`) }),
      size: asInt(record.size, `${where}.size`),
      color: asString(record.color, `${where}.color`),
      position: asString(record.position, `${where}.position`),
    } satisfies Style;
  });
  uniqueIds(styles, 'styles');
  const styleIds = new Set(styles.map((style) => style.id));

  const captions = asArray(project.captions, 'captions').map((item, index) => {
    const where = `captions[${index}]`;
    const record = asRecord(item, where);
    noUnknownKeys(record, ['id', 'fromAnchor', 'toAnchor', 'tokenIds', 'styleId'], where);
    const from = asString(record.fromAnchor, `${where}.fromAnchor`);
    const to = asString(record.toAnchor, `${where}.toAnchor`);
    if (!anchorIds.has(from) || !anchorIds.has(to)) fail(where, `锚点不存在(${from} / ${to})`);
    const styleId = asString(record.styleId, `${where}.styleId`);
    if (!styleIds.has(styleId)) fail(`${where}.styleId`, `没有这个样式:${styleId}`);
    const own = asArray(record.tokenIds, `${where}.tokenIds`).map((id, position) =>
      asString(id, `${where}.tokenIds[${position}]`),
    );
    for (const tokenId of own) {
      if (!tokenIds.has(tokenId)) fail(`${where}.tokenIds`, `没有这个词:${tokenId}`);
    }
    return { id: asString(record.id, `${where}.id`), fromAnchor: from, toAnchor: to, tokenIds: own, styleId } satisfies Caption;
  });
  uniqueIds(captions, 'captions');

  const effects = asArray(project.effects, 'effects').map((item, index) => {
    const where = `effects[${index}]`;
    const record = asRecord(item, where);
    noUnknownKeys(record, ['id', 'atAnchor', 'durationFrames', 'type', 'params'], where);
    const at = asString(record.atAnchor, `${where}.atAnchor`);
    if (!anchorIds.has(at)) fail(where, `锚点不存在:${at}`);
    const durationFrames = asInt(record.durationFrames, `${where}.durationFrames`);
    if (durationFrames <= 0) fail(`${where}.durationFrames`, '要大于 0');
    return {
      id: asString(record.id, `${where}.id`),
      atAnchor: at,
      durationFrames,
      type: asEnum(record.type, ['highlight', 'title-pop'] as const, `${where}.type`),
      params: asRecord(record.params, `${where}.params`) as Record<string, unknown>,
    } satisfies Effect;
  });
  uniqueIds(effects, 'effects');

  const alignments = asArray(project.alignments, 'alignments').map((item, index) =>
    validateAlignment(item, index, segmentIds, assetIds, tokenIds),
  );

  const timeline =
    project.timeline === undefined ? undefined : validateTimeline(project.timeline, shotIds, shots.length);
  if (timeline !== undefined) {
    for (const alignment of alignments) {
      const segmentStart = segmentStartFrame(shots, timeline, alignment.segmentId);
      if (segmentStart === undefined) continue;
      let previousEnd = -1;
      for (const word of alignment.words) {
        if (word.startFrame < 0) fail('alignments', `${alignment.segmentId} 的词窗不能是负数`);
        if (word.startFrame < previousEnd) fail('alignments', `${alignment.segmentId} 的词窗没有单调递增`);
        if (word.endFrame <= word.startFrame) fail('alignments', `${alignment.segmentId} 的 ${word.tokenId} 终点要大于起点`);
        previousEnd = word.endFrame;
      }
    }
  }

  const reference =
    project.reference === undefined ? undefined : validateReference(project.reference, assetIds);
  const analysis = project.analysis === undefined ? undefined : validateAnalysis(project.analysis, shots.length);
  const audio = project.audio === undefined ? undefined : validateAudio(project.audio, assetIds);
  const locks = project.locks === undefined ? undefined : validateLocks(project.locks, assetIds);

  const variants = asArray(project.variants, 'variants').map((item, index) => {
    const where = `variants[${index}]`;
    const record = asRecord(item, where);
    noUnknownKeys(record, ['id', 'baseHash', 'patch', 'seedByShot'], where);
    const patch = asArray(record.patch, `${where}.patch`).map((op, position) =>
      validatePatchOp(op, `${where}.patch[${position}]`),
    );
    const seedByShot = record.seedByShot;
    return {
      id: asString(record.id, `${where}.id`),
      baseHash: asSha(record.baseHash, `${where}.baseHash`),
      patch,
      ...(seedByShot === undefined ? {} : { seedByShot: asSeedMap(seedByShot, `${where}.seedByShot`) }),
    } satisfies Variant;
  });
  uniqueIds(variants, 'variants');

  const budget = asRecord(project.budget, 'budget');
  noUnknownKeys(budget, ['maxVariants', 'maxNewCandidates', 'maxDiskBytes', 'maxWallSeconds', 'gpuWorkers'], 'budget');
  if (asInt(budget.gpuWorkers, 'budget.gpuWorkers') !== 1) fail('budget.gpuWorkers', '首版只许 1(单卡串行)');

  const output = asRecord(project.output, 'output');
  noUnknownKeys(output, ['container', 'path', 'metadata'], 'output');
  const outputPath = asString(output.path, 'output.path');
  assertRelativePath(outputPath, 'output.path');
  if (output.container !== 'mp4') fail('output.container', '首版只出 mp4');

  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    revision,
    ...(project.parentHash === undefined ? {} : { parentHash: project.parentHash as string }),
    policy: {
      use: 'personal',
      distribution: 'none',
      commercial: false,
      network: 'loopback-only',
      models,
    },
    ...(reference === undefined ? {} : { reference }),
    ...(analysis === undefined ? {} : { analysis }),
    ...(script === undefined ? {} : { script }),
    assets,
    ...(locks === undefined ? {} : { locks }),
    shots,
    candidates,
    ...(audio === undefined ? {} : { audio }),
    alignments,
    anchors,
    captions,
    effects,
    styles,
    ...(timeline === undefined ? {} : { timeline }),
    variants,
    budget: {
      maxVariants: asInt(budget.maxVariants, 'budget.maxVariants'),
      maxNewCandidates: asInt(budget.maxNewCandidates, 'budget.maxNewCandidates'),
      maxDiskBytes: asInt(budget.maxDiskBytes, 'budget.maxDiskBytes'),
      maxWallSeconds: asInt(budget.maxWallSeconds, 'budget.maxWallSeconds'),
      gpuWorkers: 1,
    },
    output: {
      container: 'mp4',
      path: outputPath,
      metadata: asString(output.metadata ?? OUTPUT_METADATA, 'output.metadata'),
    },
  };
}

function asProbe(value: unknown, where: string): Probe {
  const record = asRecord(value, where);
  noUnknownKeys(record, ['width', 'height', 'fps', 'frames', 'audio', 'durationSeconds'], where);
  return {
    width: asInt(record.width, `${where}.width`),
    height: asInt(record.height, `${where}.height`),
    fps: asFps(record.fps, `${where}.fps`),
    frames: asInt(record.frames, `${where}.frames`),
    audio: asBool(record.audio, `${where}.audio`),
    ...(record.durationSeconds === undefined
      ? {}
      : { durationSeconds: asNumber(record.durationSeconds, `${where}.durationSeconds`) }),
  };
}

function asSeedMap(value: unknown, where: string): Record<string, number> {
  const record = asRecord(value, where);
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) out[key] = asInt(item, `${where}.${key}`);
  return out;
}

function validateScript(value: unknown): Script {
  const record = asRecord(value, 'script');
  noUnknownKeys(record, ['language', 'segments', 'tokens'], 'script');
  if (record.language !== 'zh') fail('script.language', '首版只许 zh');
  const segments = asArray(record.segments, 'script.segments').map((item, index) => {
    const where = `script.segments[${index}]`;
    const segment = asRecord(item, where);
    noUnknownKeys(segment, ['id', 'role', 'speakerId', 'text', 'tokenIds'], where);
    return {
      id: asString(segment.id, `${where}.id`),
      role: asString(segment.role, `${where}.role`),
      ...(segment.speakerId === undefined ? {} : { speakerId: asString(segment.speakerId, `${where}.speakerId`) }),
      text: asString(segment.text, `${where}.text`),
      tokenIds: asArray(segment.tokenIds, `${where}.tokenIds`).map((token, position) =>
        asString(token, `${where}.tokenIds[${position}]`),
      ),
    } satisfies ScriptSegment;
  });
  uniqueIds(segments, 'script.segments');
  const segmentIds = new Set(segments.map((segment) => segment.id));
  const tokens = asArray(record.tokens, 'script.tokens').map((item, index) => {
    const where = `script.tokens[${index}]`;
    const token = asRecord(item, where);
    noUnknownKeys(token, ['id', 'segmentId', 'speech', 'display', 'charRange'], where);
    const segmentId = asString(token.segmentId, `${where}.segmentId`);
    if (!segmentIds.has(segmentId)) fail(`${where}.segmentId`, `没有这个段:${segmentId}`);
    const range = asArray(token.charRange, `${where}.charRange`);
    if (range.length !== 2) fail(`${where}.charRange`, '要正好两个数 [start, end)');
    const start = asInt(range[0], `${where}.charRange[0]`);
    const end = asInt(range[1], `${where}.charRange[1]`);
    if (end <= start) fail(`${where}.charRange`, 'end 要大于 start');
    const segment = segments.find((item) => item.id === segmentId);
    const text = segment?.text ?? '';
    if (end > [...text].length) fail(`${where}.charRange`, `超出这一段文案的长度(${end} > ${[...text].length})`);
    return {
      id: asString(token.id, `${where}.id`),
      segmentId,
      speech: asString(token.speech, `${where}.speech`),
      display: asString(token.display, `${where}.display`),
      charRange: [start, end] as [number, number],
    } satisfies ScriptToken;
  });
  uniqueIds(tokens, 'script.tokens');
  const tokenIds = new Set(tokens.map((token) => token.id));
  for (const segment of segments) {
    for (const tokenId of segment.tokenIds) {
      if (!tokenIds.has(tokenId)) fail('script.segments', `${segment.id} 引用不存在的词 ${tokenId}`);
    }
  }
  for (const token of tokens) {
    const segment = segments.find((item) => item.id === token.segmentId);
    if (segment !== undefined && segment.text.slice(token.charRange[0], token.charRange[1]) === '') {
      fail('script.tokens', `${token.id} 的 charRange 在「${segment.text}」里取到空串`);
    }
  }
  return { language: 'zh', segments, tokens };
}

function validateAnchor(value: unknown, index: number, tokenIds: Set<string>, shotIds: Set<string>): Anchor {
  const where = `anchors[${index}]`;
  const record = asRecord(value, where);
  const kind = record.kind;
  if (kind === 'shot') {
    noUnknownKeys(record, ['id', 'kind', 'shotId', 'frame'], where);
    const shotId = asString(record.shotId, `${where}.shotId`);
    if (!shotIds.has(shotId)) fail(`${where}.shotId`, `没有这个镜头:${shotId}`);
    return { id: asString(record.id, `${where}.id`), kind: 'shot', shotId, frame: asInt(record.frame, `${where}.frame`) };
  }
  noUnknownKeys(record, ['id', 'kind', 'tokenId', 'edge', 'offsetFrames'], where);
  const tokenId = asString(record.tokenId, `${where}.tokenId`);
  if (!tokenIds.has(tokenId)) fail(`${where}.tokenId`, `没有这个词:${tokenId}`);
  return {
    id: asString(record.id, `${where}.id`),
    kind: 'word',
    tokenId,
    edge: asEnum(record.edge, ['start', 'end'] as const, `${where}.edge`),
    offsetFrames: asInt(record.offsetFrames ?? 0, `${where}.offsetFrames`),
  };
}

function validateAlignment(
  value: unknown,
  index: number,
  segmentIds: Set<string>,
  assetIds: Set<string>,
  tokenIds: Set<string>,
): Alignment {
  const where = `alignments[${index}]`;
  const record = asRecord(value, where);
  noUnknownKeys(record, ['segmentId', 'assetId', 'audioHash', 'scriptHash', 'fps', 'method', 'status', 'words'], where);
  const segmentId = asString(record.segmentId, `${where}.segmentId`);
  if (!segmentIds.has(segmentId)) fail(`${where}.segmentId`, `没有这个段:${segmentId}`);
  const assetId = asString(record.assetId, `${where}.assetId`);
  if (!assetIds.has(assetId)) fail(`${where}.assetId`, `没有这个资产:${assetId}`);
  const words = asArray(record.words, `${where}.words`).map((item, position) => {
    const spot = `${where}.words[${position}]`;
    const word = asRecord(item, spot);
    noUnknownKeys(word, ['tokenId', 'startFrame', 'endFrame'], spot);
    const tokenId = asString(word.tokenId, `${spot}.tokenId`);
    if (!tokenIds.has(tokenId)) fail(`${spot}.tokenId`, `没有这个词:${tokenId}`);
    return {
      tokenId,
      startFrame: asInt(word.startFrame, `${spot}.startFrame`),
      endFrame: asInt(word.endFrame, `${spot}.endFrame`),
    };
  });
  if (record.method !== 'manual') fail(`${where}.method`, '首版只许 manual(人工校订)');
  if (record.status !== 'confirmed') fail(`${where}.status`, '首版只许 confirmed');
  return {
    segmentId,
    assetId,
    audioHash: asSha(record.audioHash, `${where}.audioHash`),
    scriptHash: asSha(record.scriptHash, `${where}.scriptHash`),
    fps: asFps(record.fps, `${where}.fps`),
    method: 'manual',
    status: 'confirmed',
    words,
  };
}

function validatePatchOp(value: unknown, where: string): PatchOp {
  const record = asRecord(value, where);
  noUnknownKeys(record, ['op', 'path', 'value'], where);
  const op = asEnum(record.op, ['replace', 'add', 'remove'] as const, `${where}.op`);
  const path = asString(record.path, `${where}.path`);
  if (op !== 'remove' && record.value === undefined) fail(where, `${op} 要给 value`);
  return { op, path, ...(record.value === undefined ? {} : { value: record.value }) };
}

function validateTimeline(value: unknown, shotIds: Set<string>, shotCount: number): Timeline {
  const record = asRecord(value, 'timeline');
  noUnknownKeys(record, ['fps', 'width', 'height', 'placements', 'totalFrames'], 'timeline');
  const placements = asArray(record.placements, 'timeline.placements').map((item, index) => {
    const where = `timeline.placements[${index}]`;
    const placement = asRecord(item, where);
    noUnknownKeys(placement, ['shotId', 'startFrame', 'durationFrames'], where);
    const shotId = asString(placement.shotId, `${where}.shotId`);
    if (!shotIds.has(shotId)) fail(`${where}.shotId`, `没有这个镜头:${shotId}`);
    const startFrame = asInt(placement.startFrame, `${where}.startFrame`);
    const durationFrames = asInt(placement.durationFrames, `${where}.durationFrames`);
    if (durationFrames <= 0) fail(`${where}.durationFrames`, '要大于 0');
    return { shotId, startFrame, durationFrames };
  });
  if (placements.length !== shotCount) {
    fail('timeline.placements', `首版要求每个镜头一处、连续无重叠(${placements.length} 处 vs ${shotCount} 个镜头)`);
  }
  let cursor = 0;
  for (const [index, placement] of placements.entries()) {
    if (placement.startFrame !== cursor) {
      fail(`timeline.placements[${index}]`, `要把时钟接上:期望 startFrame=${cursor},收到 ${placement.startFrame}`);
    }
    cursor += placement.durationFrames;
  }
  const totalFrames = asInt(record.totalFrames, 'timeline.totalFrames');
  if (totalFrames !== cursor) fail('timeline.totalFrames', `要等于各段之和 ${cursor},收到 ${totalFrames}`);
  return {
    fps: asFps(record.fps, 'timeline.fps'),
    width: asInt(record.width, 'timeline.width'),
    height: asInt(record.height, 'timeline.height'),
    placements,
    totalFrames,
  };
}

function validateReference(value: unknown, assetIds: Set<string>): Reference {
  const record = asRecord(value, 'reference');
  noUnknownKeys(record, ['assetId', 'referenceUrl', 'probe', 'analysisStatus'], 'reference');
  const assetId = asString(record.assetId, 'reference.assetId');
  if (!assetIds.has(assetId)) fail('reference.assetId', `没有这个资产:${assetId}`);
  return {
    assetId,
    ...(record.referenceUrl === undefined
      ? {}
      : { referenceUrl: asString(record.referenceUrl, 'reference.referenceUrl') }),
    probe: asProbe(record.probe, 'reference.probe'),
    analysisStatus: asEnum(record.analysisStatus, ['draft', 'confirmed'] as const, 'reference.analysisStatus'),
  };
}

function validateAnalysis(value: unknown, shotCount: number): Analysis {
  const record = asRecord(value, 'analysis');
  noUnknownKeys(record, ['shots', 'rhythm', 'structure', 'captionStyle', 'voice', 'evidence'], 'analysis');
  const shots = asArray(record.shots, 'analysis.shots').map((item, index) => {
    const where = `analysis.shots[${index}]`;
    const shot = asRecord(item, where);
    noUnknownKeys(shot, ['id', 'startFrame', 'endFrame', 'description', 'captionText', 'cutStyle'], where);
    const startFrame = asInt(shot.startFrame, `${where}.startFrame`);
    const endFrame = asInt(shot.endFrame, `${where}.endFrame`);
    if (endFrame <= startFrame) fail(where, `endFrame(${endFrame}) 要大于 startFrame(${startFrame})`);
    return {
      id: asString(shot.id, `${where}.id`),
      startFrame,
      endFrame,
      description: asString(shot.description, `${where}.description`),
      captionText: asString(shot.captionText, `${where}.captionText`),
      cutStyle: asString(shot.cutStyle, `${where}.cutStyle`),
    } satisfies AnalysisShot;
  });
  uniqueIds(shots, 'analysis.shots');
  const analysisShotIds = new Set(shots.map((shot) => shot.id));
  const rhythm = asArray(record.rhythm, 'analysis.rhythm').map((item, index) => {
    const where = `analysis.rhythm[${index}]`;
    const beat = asRecord(item, where);
    noUnknownKeys(beat, ['shotId', 'beatFrame', 'pauseFrames'], where);
    const shotId = asString(beat.shotId, `${where}.shotId`);
    if (!analysisShotIds.has(shotId)) fail(`${where}.shotId`, `没有这个参考镜头:${shotId}`);
    return {
      shotId,
      beatFrame: asInt(beat.beatFrame, `${where}.beatFrame`),
      pauseFrames: asInt(beat.pauseFrames, `${where}.pauseFrames`),
    } satisfies RhythmPoint;
  });
  const structure = asArray(record.structure, 'analysis.structure').map((item, index) => {
    const where = `analysis.structure[${index}]`;
    const beat = asRecord(item, where);
    noUnknownKeys(beat, ['id', 'role', 'shotIds'], where);
    return {
      id: asString(beat.id, `${where}.id`),
      role: asString(beat.role, `${where}.role`),
      shotIds: asArray(beat.shotIds, `${where}.shotIds`).map((id, position) =>
        asString(id, `${where}.shotIds[${position}]`),
      ),
    } satisfies StructureBeat;
  });
  const style = asRecord(record.captionStyle, 'analysis.captionStyle');
  noUnknownKeys(style, ['font', 'size', 'color', 'position', 'maxCharsPerLine'], 'analysis.captionStyle');
  const voice = asRecord(record.voice, 'analysis.voice');
  noUnknownKeys(voice, ['description', 'observedShotIds', 'status'], 'analysis.voice');
  const evidence = asArray(record.evidence, 'analysis.evidence').map((item, index) => {
    const where = `analysis.evidence[${index}]`;
    const point = asRecord(item, where);
    noUnknownKeys(point, ['field', 'shotId', 'frame', 'method'], where);
    return {
      field: asString(point.field, `${where}.field`),
      ...(point.shotId === undefined ? {} : { shotId: asString(point.shotId, `${where}.shotId`) }),
      ...(point.frame === undefined ? {} : { frame: asInt(point.frame, `${where}.frame`) }),
      method: asEnum(point.method, ['manual', 'probe'] as const, `${where}.method`),
    } satisfies Evidence;
  });
  void shotCount;
  return {
    shots,
    rhythm,
    structure,
    captionStyle: {
      font: asString(style.font, 'analysis.captionStyle.font'),
      size: asInt(style.size, 'analysis.captionStyle.size'),
      color: asString(style.color, 'analysis.captionStyle.color'),
      position: asString(style.position, 'analysis.captionStyle.position'),
      maxCharsPerLine: asInt(style.maxCharsPerLine, 'analysis.captionStyle.maxCharsPerLine'),
    },
    voice: {
      description: asString(voice.description, 'analysis.voice.description'),
      observedShotIds: asArray(voice.observedShotIds, 'analysis.voice.observedShotIds').map((id, index) =>
        asString(id, `analysis.voice.observedShotIds[${index}]`),
      ),
      status: asEnum(voice.status, ['draft', 'confirmed'] as const, 'analysis.voice.status'),
    },
    evidence,
  };
}

function validateAudio(value: unknown, assetIds: Set<string>): AudioTrack {
  const record = asRecord(value, 'audio');
  noUnknownKeys(record, ['mode', 'assetIds', 'voiceDirection', 'alignmentStatus'], 'audio');
  const ids = asArray(record.assetIds, 'audio.assetIds').map((id, index) => {
    const text = asString(id, `audio.assetIds[${index}]`);
    if (!assetIds.has(text)) fail(`audio.assetIds[${index}]`, `没有这个资产:${text}`);
    return text;
  });
  return {
    mode: asEnum(record.mode, ['h3', 'local', 'silent'] as const, 'audio.mode'),
    assetIds: ids,
    ...(record.voiceDirection === undefined
      ? {}
      : { voiceDirection: asString(record.voiceDirection, 'audio.voiceDirection') }),
    alignmentStatus: asEnum(record.alignmentStatus, ['pending', 'confirmed'] as const, 'audio.alignmentStatus'),
  };
}

function validateLocks(value: unknown, assetIds: Set<string>): Locks {
  const record = asRecord(value, 'locks');
  noUnknownKeys(
    record,
    ['pluginCommit', 'adapterVersion', 'workflow', 'models', 'comfyuiVersion', 'ffmpegVersion', 'fontAssetIds', 'deferred'],
    'locks',
  );
  const workflow =
    record.workflow === undefined
      ? undefined
      : (() => {
          const lock = asRecord(record.workflow, 'locks.workflow');
          noUnknownKeys(lock, ['id', 'path', 'sha256', 'sourceCommit'], 'locks.workflow');
          const path = asString(lock.path, 'locks.workflow.path');
          assertRelativePath(path, 'locks.workflow.path');
          return {
            id: asString(lock.id, 'locks.workflow.id'),
            path,
            sha256: asSha(lock.sha256, 'locks.workflow.sha256'),
            ...(lock.sourceCommit === undefined
              ? {}
              : { sourceCommit: asString(lock.sourceCommit, 'locks.workflow.sourceCommit') }),
          } satisfies WorkflowLock;
        })();
  const models = asArray(record.models, 'locks.models').map((item, index) => {
    const where = `locks.models[${index}]`;
    const model = asRecord(item, where);
    noUnknownKeys(model, ['file', 'sha256'], where);
    return { file: asString(model.file, `${where}.file`), sha256: asSha(model.sha256, `${where}.sha256`) };
  });
  const fontAssetIds = asArray(record.fontAssetIds, 'locks.fontAssetIds').map((id, index) => {
    const text = asString(id, `locks.fontAssetIds[${index}]`);
    if (!assetIds.has(text)) fail(`locks.fontAssetIds[${index}]`, `没有这个字体资产:${text}`);
    return text;
  });
  return {
    ...(record.pluginCommit === undefined
      ? {}
      : { pluginCommit: asString(record.pluginCommit, 'locks.pluginCommit') }),
    adapterVersion: asString(record.adapterVersion, 'locks.adapterVersion'),
    ...(workflow === undefined ? {} : { workflow }),
    models,
    ...(record.comfyuiVersion === undefined
      ? {}
      : { comfyuiVersion: asString(record.comfyuiVersion, 'locks.comfyuiVersion') }),
    ...(record.ffmpegVersion === undefined
      ? {}
      : { ffmpegVersion: asString(record.ffmpegVersion, 'locks.ffmpegVersion') }),
    fontAssetIds,
    deferred: asArray(record.deferred ?? [], 'locks.deferred').map((item, index) =>
      asString(item, `locks.deferred[${index}]`),
    ),
  };
}

/* ------------------------------------------------------------------ *
 * 时间轴上的段起始帧:词锚全局帧 = 段起始帧 + 实测段内帧 + offset
 * ------------------------------------------------------------------ */

export function segmentStartFrame(shots: Shot[], timeline: Timeline, segmentId: string): number | undefined {
  let best: number | undefined;
  for (const placement of timeline.placements) {
    const shot = shots.find((item) => item.id === placement.shotId);
    if (shot?.segmentId !== segmentId) continue;
    if (best === undefined || placement.startFrame < best) best = placement.startFrame;
  }
  return best;
}

/** 走一遍全部引用关系,输出人看得懂的缺口清单(不修、不猜)。 */
export function projectIssues(project: Project): string[] {
  const issues: string[] = [];
  if (project.reference === undefined) issues.push('还没有参考片:先跑 vidroom_reference 导本地样片');
  if (project.script === undefined) issues.push('还没有文案与分词(script)');
  if (project.shots.length === 0) issues.push('还没有目标镜头(shots)');
  for (const shot of project.shots) {
    if (shot.selectedCandidateId === undefined) issues.push(`镜头 ${shot.id} 还没选定候选`);
  }
  if (project.timeline === undefined && project.shots.length > 0) issues.push('还没有 timeline(合成时钟)');
  if (project.anchors.length === 0) issues.push('还没有词锚(anchors)');
  return issues;
}
