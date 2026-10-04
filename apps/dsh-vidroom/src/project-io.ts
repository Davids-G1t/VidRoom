/**
 * 工程的落盘与改写:读/写 `project.vr.json`、安全解析工程内路径、导入本地素材、
 * 白名单 patch。
 *
 * 两条硬线:①工程内的资源一律相对路径且不许越出工程根(含符号链接);
 * ②patch 只走白名单,任何试图改边界字段(policy / budget / assets / candidates …)的
 * patch 都直接拒掉 —— 不接受任意代码 patch。
 */

import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { VidroomError } from './errors.js';
import { probeMedia, sha256File, type MediaTools, type Probe } from './media.js';
import {
  assertRelativePath,
  canonicalJson,
  PROJECT_FILE,
  projectHash,
  type Asset,
  type AssetKind,
  type PatchOp,
  type Project,
  validateProject,
} from './project.js';

/** 工程文件在工程根里的位置。 */
export function projectFileOf(dir: string): string {
  return join(dir, PROJECT_FILE);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 读工程(带 schema 校验)。文件不在 → `PROJECT_NOT_FOUND`。 */
export function readProject(dir: string): Project {
  const file = projectFileOf(dir);
  if (!existsSync(file)) throw new VidroomError('PROJECT_NOT_FOUND', `没有工程文件:${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new VidroomError('PROJECT_INVALID', `工程文件读不成 JSON:${(error as Error).message}`);
  }
  return validateProject(parsed);
}

/** 写工程(先写临时文件再 rename,避免半截文件)。 */
export function writeProject(dir: string, project: Project): string {
  ensureDir(dir);
  // 写之前先验:回写、夹具、测试都不能绕过 schema(不然“验过的工程”就只是口头保证)。
  const validated = validateProject(project);
  const file = projectFileOf(dir);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
  return file;
}

/** 工程内相对路径 → 绝对路径,并保证没越出工程根(符号链接也拦)。 */
export function resolveInside(dir: string, relativePath: string, what = 'path'): string {
  assertRelativePath(relativePath, what);
  const root = realpathSync(resolve(dir));
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new VidroomError('PROJECT_INVALID', `${what} 越出工程根:${relativePath}`);
  }
  if (!existsSync(target)) {
    throw new VidroomError('PROJECT_INVALID', `${what} 指向的文件不在:${relativePath}`);
  }
  const real = realpathSync(target);
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new VidroomError('PROJECT_INVALID', `${what} 经符号链接越出工程根:${relativePath}`);
  }
  return real;
}

/** 写之前核目标实路径没越出工程根(目录/文件本身可能是越界符号链)。 */
function assertInsideRoot(dir: string, target: string, what: string): void {
  const root = realpathSync(resolve(dir));
  const real = realpathSync(target);
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new VidroomError('PROJECT_INVALID', `${what} 经符号链接越出工程根:${target}`);
  }
}

/** 下一个可用 id:`asset-1`、`shot-2` 这种,稳定且唯一。 */
export function nextId(prefix: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  for (let index = 1; ; index += 1) {
    const id = `${prefix}-${index}`;
    if (!taken.has(id)) return id;
  }
}

export interface ImportOptions {
  /** 源文件绝对路径(本地片、录音、字体)。 */
  sourcePath: string;
  kind: AssetKind;
  origin: Asset['origin'];
  /** 已有的资产 id(用来排下一个 id)。 */
  existingIds: Iterable<string>;
  sourceRunId?: string;
  tools: MediaTools;
}

/** 把外部文件复制进 `assets/`,算 sha256、探一次媒体属性(字体/工作流不探)。 */
/** `assets/` 里已经占掉的 id:光看工程里的记录不够 —— 同一个 id 换个后缀就是另一个文件。 */
function assetIdsOnDisk(dir: string): string[] {
  const assetsDir = join(dir, 'assets');
  if (!existsSync(assetsDir)) return [];
  return readdirSync(assetsDir)
    .map((name) => name.replace(/\.[^.]+$/, ''))
    .filter((stem) => /^(asset|font)-\d+$/.test(stem));
}

export async function importAsset(dir: string, options: ImportOptions): Promise<Asset> {
  const source = resolve(options.sourcePath);
  if (!existsSync(source)) {
    throw new VidroomError('PROJECT_INVALID', `要导入的文件不在:${options.sourcePath}`);
  }
  if (!statSync(source).isFile()) {
    throw new VidroomError('PROJECT_INVALID', `要导入的不是普通文件:${options.sourcePath}`);
  }
  const prefix = options.kind === 'font' ? 'font' : 'asset';
  const suffix = extname(source).toLowerCase();
  const assetsDir = join(dir, 'assets');
  ensureDir(assetsDir);
  // 写之前先核:`assets/` 不能是越界符号链,目标位置不能是符号链(不然 copyFileSync 会顺着它写到工程外)。
  assertInsideRoot(dir, assetsDir, '资产目录');

  // 排一个真没人占的路径:光看工程里的 id 不够 —— 变体各自从同一份快照起跑,
  // 会算出同一个 `asset-N` 然后把别人刚生成的素材覆盖掉。所以用 O_EXCL 占位,撞了就换下一个 id。
  // 盘上已有的文件名也要算进去:同名不同后缀(`asset-1.wav` 与 `asset-1.mp4`)是两份资产,
  // 但 id 是同一个 —— 那样工程里会出现两个 `asset-1`,谁引用谁都说不清。
  const taken = new Set<string>([...options.existingIds, ...assetIdsOnDisk(dir)]);
  let id = '';
  let relativePath = '';
  let target = '';
  for (;;) {
    id = nextId(prefix, taken);
    relativePath = `assets/${id}${suffix}`;
    target = join(dir, relativePath);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new VidroomError('PROJECT_INVALID', `资产位置是符号链接,不顺着它写:${relativePath}`);
    }
    try {
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      taken.add(id);
    }
  }
  const sha256 = await sha256File(target);
  const probe: Probe | undefined =
    options.kind === 'video' || options.kind === 'audio'
      ? await probeMedia(target, options.tools, { requireVideo: options.kind === 'video' })
      : undefined;
  return {
    id,
    kind: options.kind,
    path: relativePath,
    sha256,
    origin: options.origin,
    ...(probe === undefined ? {} : { probe }),
    ...(options.sourceRunId === undefined ? {} : { sourceRunId: options.sourceRunId }),
  };
}

/* ------------------------------------------------------------------ *
 * 白名单 patch
 * ------------------------------------------------------------------ */

/** 能改/能补的地方:文案、提示词与生成参数、显式候选、edit、样式、锚/字幕/特效、参考分析校订、音轨、预算、时钟与镜头。 */
const PATCHABLE: RegExp[] = [
  /^script(\.[\w-]+|\[[^\]]+\])*$/,
  /^audio(\.[\w-]+|\[[^\]]+\])*$/,
  /^analysis(\.[\w-]+|\[[^\]]+\])*$/,
  /^reference\.analysisStatus$/,
  /^shots\[[^\]]+\]\.generation\.(prompt|seed|requestedSeconds|width|height|fps|steps|sampler|scheduler|model)$/,
  /^shots\[[^\]]+\]\.selectedCandidateId$/,
  /^shots\[[^\]]+\]\.edit(\.[\w-]+)?$/,
  /^styles(\[[^\]]+\](\.[\w-]+)?)?$/,
  /^captions(\[[^\]]+\])?$/,
  /^effects(\[[^\]]+\])?$/,
  /^anchors(\[[^\]]+\])?$/,
  /^budget(\.[\w-]+)?$/,
  // 两个建的口子:补镜头、定合成时钟(新建/登记参考后的 `shots: []` 靠它补)。
  /^shots$/,
  /^timeline$/,
];

const FORBIDDEN_SEGMENT = new Set(['__proto__', 'prototype', 'constructor']);

function splitPath(path: string, where: string): string[] {
  const segments: string[] = [];
  for (const part of path.split('.')) {
    const match = /^([A-Za-z_][\w-]*)((?:\[[^\]]*\])*)$/.exec(part);
    if (match === null) throw new VidroomError('PATCH_REJECTED', `${where}:路径读不懂 —— ${path}`);
    let head = match[1] ?? '';
    if (FORBIDDEN_SEGMENT.has(head)) throw new VidroomError('PATCH_REJECTED', `${where}:路径里有禁用的字段名 ${head}`);
    let rest = match[2] ?? '';
    while (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      const key = rest.slice(1, close);
      if (FORBIDDEN_SEGMENT.has(key)) throw new VidroomError('PATCH_REJECTED', `${where}:路径里有禁用的字段名 ${key}`);
      segments.push(`${head}[${key}]`);
      rest = rest.slice(close + 1);
      head = '';
    }
    if (head !== '') segments.push(head);
  }
  return segments;
}

/** 把 `shots[shot-1]` 这样的段解析成父对象的键/下标。 */
function locate(container: unknown, segment: string, where: string): { parent: Record<string, unknown> | unknown[]; key: string | number; isArray: boolean } {
  const match = /^([A-Za-z_][\w-]*)(?:\[([^\]]*)\])?$/.exec(segment);
  if (match === null) throw new VidroomError('PATCH_REJECTED', `${where}:段读不懂 —— ${segment}`);
  const name = match[1] ?? '';
  const index = match[2];
  if (container === null || typeof container !== 'object') throw new VidroomError('PATCH_REJECTED', `${where}:${name} 不在对象上`);
  if (index === undefined) {
    return { parent: container as Record<string, unknown>, key: name, isArray: false };
  }
  const list = (container as Record<string, unknown>)[name];
  if (!Array.isArray(list)) throw new VidroomError('PATCH_REJECTED', `${where}:${name} 不是数组`);
  const byId = /^\d+$/.test(index) ? Number(index) : list.findIndex((item) => (item as { id?: unknown })?.id === index);
  if (typeof byId !== 'number' || byId < 0 || byId >= list.length) {
    throw new VidroomError('PATCH_REJECTED', `${where}:${name}[${index}] 不在数组里`);
  }
  return { parent: list, key: byId, isArray: true };
}

export interface PatchResult {
  project: Project;
  changedPaths: string[];
  invalidatedShotIds: string[];
  /** 因为失效被清掉选定的镜头:它们本来选定着旧候选,不能再拿旧片顶。 */
  selectionClearedShotIds: string[];
  alignmentRequired: boolean;
}

/** 应用一组 patch,产出新 revision。任何一条不合法 → 整体拒绝,不半途改一半。 */
export function applyPatch(project: Project, patch: PatchOp[], options: { seedByShot?: Record<string, number> } = {}): PatchResult {
  if (patch.length === 0) throw new VidroomError('PATCH_REJECTED', 'patch 是空的');
  const next = structuredClone(project) as unknown as Record<string, unknown>;
  const changedPaths: string[] = [];

  for (const op of patch) {
    if (!PATCHABLE.some((pattern) => pattern.test(op.path))) {
      throw new VidroomError(
        'PATCH_REJECTED',
        `不许改 ${op.path};能改的只有文案、prompt/种子/尺寸/帧数/采样、显式候选、edit、样式、锚/字幕/特效、参考分析校订、音轨与预算;新增镜头用 add + shots,定合成时钟用 timeline`,
      );
    }
    const segments = splitPath(op.path, 'patch');
    // 两个「建」入口:补镜头(`add` + `shots`)与定合成时钟(`add`/`replace` + `timeline`)。
    // 没有它们,新建或登记参考后的工程 `shots: []` 永远补不上,只能用手改 JSON —— 那样工具面就不闭环。
    if (segments.length === 1) {
      if (op.path === 'shots' && op.op === 'add') {
        const shots = (next.shots as unknown[] | undefined) ?? [];
        if (Array.isArray(op.value)) shots.push(...op.value);
        else shots.push(op.value);
        next.shots = shots;
        changedPaths.push(op.path);
        continue;
      }
      if (op.path === 'timeline') {
        next.timeline = op.value;
        changedPaths.push(op.path);
        continue;
      }
    }
    let cursor: unknown = next;
    for (const segment of segments.slice(0, -1)) {
      const { parent, key } = locate(cursor, segment, 'patch');
      cursor = (parent as Record<string, unknown>)[String(key)];
      if (cursor === undefined) throw new VidroomError('PATCH_REJECTED', `patch:${op.path} 中途断在 ${segment}`);
    }
    const last = segments.at(-1) ?? '';
    const { parent, key, isArray } = locate(cursor, last, 'patch');
    if (op.op === 'remove') {
      if (isArray) (parent as unknown[]).splice(Number(key), 1);
      else delete (parent as Record<string, unknown>)[String(key)];
    } else {
      (parent as Record<string, unknown>)[String(key)] = op.value;
    }
    changedPaths.push(op.path);
  }

  // seedByShot:只覆盖镜头自己的 seed,不改别的字段。
  for (const [shotId, seed] of Object.entries(options.seedByShot ?? {})) {
    const shot = (next.shots as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === shotId);
    if (shot === undefined) throw new VidroomError('PATCH_REJECTED', `seedByShot 里的 ${shotId} 不是这个工程的镜头`);
    (shot.generation as Record<string, unknown>).seed = seed;
    changedPaths.push(`shots[${shotId}].generation.seed`);
  }

  next.revision = project.revision + 1;
  next.parentHash = projectHash(project);

  // 删/改词之后还有东西引着旧词(片段、锚点):不静默拆引用、也不让 schema 报一个读不懂的错 ——
  // 直接回 ALIGNMENT_REQUIRED,告诉调用方把引用一起改掉(设计页:改词要重校订)。
  const staged = next as unknown as Project;
  const remainingTokens = new Set((staged.script?.tokens ?? []).map((token) => token.id));
  const danglingRefs: string[] = [];
  for (const anchor of staged.anchors as Project['anchors']) {
    if (anchor.kind === 'word' && !remainingTokens.has(anchor.tokenId)) {
      danglingRefs.push(`锚点 ${anchor.id} → 词 ${anchor.tokenId}`);
    }
  }
  for (const segment of (staged.script?.segments ?? []) as Array<{ id: string; tokenIds: string[] }>) {
    for (const tokenId of segment.tokenIds) {
      if (!remainingTokens.has(tokenId)) danglingRefs.push(`段 ${segment.id} → 词 ${tokenId}`);
    }
  }
  if (danglingRefs.length > 0) {
    throw new VidroomError(
      'ALIGNMENT_REQUIRED',
      `这些引用还指着已删/已换的词:${danglingRefs.join('、')};改词请把段、锚点、字幕一起改(对齐要重校订)`,
    );
  }

  const stamped = validateProject(next);
  const invalidatedShotIds = computeInvalidatedShots(project, stamped, changedPaths);
  // 失效就是失效:连带把选定清掉,否则 plan 会接着复用那份旧片。
  const selectionClearedShotIds: string[] = [];
  for (const id of invalidatedShotIds) {
    const shot = stamped.shots.find((item) => item.id === id);
    if (shot !== undefined && shot.selectedCandidateId !== undefined) {
      shot.selectedCandidateId = undefined;
      selectionClearedShotIds.push(id);
    }
  }
  return {
    project: stamped,
    changedPaths,
    invalidatedShotIds,
    selectionClearedShotIds,
    alignmentRequired: changedPaths.some(
      (path) => path.startsWith('script') || path.startsWith('audio') || /\/edit(\/|$)/.test(path) || /\.edit(\.|$)/.test(path),
    ),
  };
}

/** 生成参数变了的镜头:旧候选不再对得上,要重新生成。 */
function computeInvalidatedShots(before: Project, after: Project, changedPaths: string[]): string[] {
  const invalidated = new Set<string>();
  for (const path of changedPaths) {
    const match = /^shots\[([^\]]+)\]\.generation\.(prompt|seed|width|height|frames|fps|model)$/.exec(path);
    if (match?.[1] !== undefined) invalidated.add(match[1]);
  }
  for (const shot of after.shots) {
    const previous = before.shots.find((item) => item.id === shot.id);
    if (previous === undefined) continue;
    // 比整体生成参数,不看改动走的是哪条路径 —— 换整块、先删后加都躲不过。
    if (canonicalJson(previous.generation) !== canonicalJson(shot.generation)) invalidated.add(shot.id);
  }
  return [...invalidated];
}

