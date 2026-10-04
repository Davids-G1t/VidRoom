/**
 * 工程的落盘与改写:读/写 `project.vr.json`、安全解析工程内路径、导入本地素材、
 * 白名单 patch。
 *
 * 两条硬线:①工程内的资源一律相对路径且不许越出工程根(含符号链接);
 * ②patch 只走白名单,任何试图改边界字段(policy / budget / assets / candidates …)的
 * patch 都直接拒掉 —— 不接受任意代码 patch。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
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
  const file = projectFileOf(dir);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
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
export async function importAsset(dir: string, options: ImportOptions): Promise<Asset> {
  const source = resolve(options.sourcePath);
  if (!existsSync(source)) {
    throw new VidroomError('PROJECT_INVALID', `要导入的文件不在:${options.sourcePath}`);
  }
  if (!statSync(source).isFile()) {
    throw new VidroomError('PROJECT_INVALID', `要导入的不是普通文件:${options.sourcePath}`);
  }
  const id = nextId(options.kind === 'font' ? 'font' : 'asset', options.existingIds);
  const suffix = extname(source).toLowerCase();
  const relativePath = `assets/${id}${suffix}`;
  const target = join(dir, relativePath);
  ensureDir(join(dir, 'assets'));
  copyFileSync(source, target);
  const sha256 = await sha256File(target);
  const probe: Probe | undefined =
    options.kind === 'video' || options.kind === 'audio' ? await probeMedia(target, options.tools) : undefined;
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

/** 能改的地方:文案、提示词、seed、显式候选、样式、锚/字幕/特效、参考分析校订、音轨。 */
const PATCHABLE: RegExp[] = [
  /^script(\.[\w-]+|\[[^\]]+\])*$/,
  /^audio(\.[\w-]+|\[[^\]]+\])*$/,
  /^analysis(\.[\w-]+|\[[^\]]+\])*$/,
  /^reference\.analysisStatus$/,
  /^shots\[[^\]]+\]\.generation\.(prompt|seed)$/,
  /^shots\[[^\]]+\]\.selectedCandidateId$/,
  /^shots\[[^\]]+\]\.edit(\.[\w-]+)?$/,
  /^styles(\[[^\]]+\](\.[\w-]+)?)?$/,
  /^captions(\[[^\]]+\])?$/,
  /^effects(\[[^\]]+\])?$/,
  /^anchors(\[[^\]]+\])?$/,
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
        `不许改 ${op.path};能改的只有文案、prompt、seed、显式候选、样式、锚/字幕/特效、参考分析校订与音轨`,
      );
    }
    const segments = splitPath(op.path, 'patch');
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

  const stamped = validateProject(next);
  const invalidatedShotIds = computeInvalidatedShots(project, stamped, changedPaths);
  return {
    project: stamped,
    changedPaths,
    invalidatedShotIds,
    alignmentRequired: changedPaths.some(
      (path) => path.startsWith('script') || path.startsWith('audio') || /\.edit(\.|$)/.test(path),
    ),
  };
}

/** 提示词/seed 变了的镜头:它的旧候选不再对得上,要重新生成。 */
function computeInvalidatedShots(before: Project, after: Project, changedPaths: string[]): string[] {
  const invalidated = new Set<string>();
  for (const path of changedPaths) {
    const match = /^shots\[([^\]]+)\]\.generation\.(prompt|seed)$/.exec(path);
    if (match?.[1] !== undefined) invalidated.add(match[1]);
  }
  for (const shot of after.shots) {
    const previous = before.shots.find((item) => item.id === shot.id);
    if (previous === undefined) continue;
    if (previous.generation.prompt !== shot.generation.prompt) invalidated.add(shot.id);
    if (previous.generation.seed !== shot.generation.seed) invalidated.add(shot.id);
  }
  return [...invalidated];
}

/** 给回执与面板用的一行工程摘要。 */
export function projectSummary(project: Project): string {
  const selected = project.shots.filter((shot) => shot.selectedCandidateId !== undefined).length;
  return [
    `revision ${project.revision}`,
    `镜头 ${project.shots.length}(已选定 ${selected})`,
    `候选 ${project.candidates.length}`,
    `资产 ${project.assets.length}`,
    `哈希 ${projectHash(project).slice(0, 12)}`,
  ].join(' · ');
}

/** 相对工程根的路径(面板上显示用)。 */
export function relativeToProject(dir: string, file: string): string {
  return relative(dir, file).split(sep).join('/');
}

/** 一份工程快照(canonical JSON),运行目录里落盘用。 */
export function snapshotOf(project: Project): string {
  return canonicalJson(project);
}
