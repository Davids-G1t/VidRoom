/**
 * 工程的落盘与改写:读/写 `project.vr.json`、安全解析工程内路径、导入本地素材、
 * 白名单 patch。
 *
 * 两条硬线:①工程内的资源一律相对路径且不许越出工程根(含符号链接);
 * ②patch 只走白名单,任何试图改边界字段(policy / budget / assets / candidates …)的
 * patch 都直接拒掉 —— 不接受任意代码 patch。
 *
 * 写入口只有三个、不许旁路:`writeProject`(整份写:新建工程的空壳、夹具/测试)、
 * `updateProject`(锁内读-改-写一条)、`applyPatch`(白名单 patch 的纯函数:只算出新工程,不落盘;
 * `baseHash` 的核对在 `updateProject` 里)。生产路径里直接调 `writeProject` 的只有新建空壳那两条
 * (建工程与首次登记参片:都在 `withProjectLock` 里,且只在文件还不存在时写);其余改写一律走
 * `updateProject` —— 它是唯一带跨进程互斥与乐观复核的写路径。
 */

import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

/**
 * 读-改-写一条工程:锁内串行 + 乐观复核。
 *
 * 为什么存在:工程写者不止一个(面板、导入、正在跑的渲染回写、CLI),而「读 → 算新工程 → 写」
 * 中间又夹着秒级的 IO(哈希/探针/生成),拿开头那份整份写回去就把这中间别人的改动抹了。
 *
 * 两道防:①**跨进程文件锁**(`project.vr.json.lock`)—— 别的前端(dsh 容器里的面板、CLI、另一个
 * 渲染进程)也写同一条工程,锁让「读-合并-写」不会交叉;②锁内再核一次哈希 —— 若有写者不守锁
 * (老的进程、手工改文件),就重读重并,最多 `UPDATE_ATTEMPTS` 次。
 *
 * 锁内只做同步的读/算/写,不放任何 IO 等待 —— 别的写者最多等 `LOCK_TRIES × LOCK_WAIT_MS` 毫秒。
 */
export function updateProject(
  dir: string,
  merge: (current: Project) => Project,
  options: { baseHash?: string } = {},
): Project {
  return withProjectLock(dir, (assertOwned) => {
    for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
      const before = readProject(dir);
      if (options.baseHash !== undefined && projectHash(before) !== options.baseHash) {
        throw new VidroomError(
          'PROJECT_HASH_MISMATCH',
          `工程已经变了(现在 ${projectHash(before).slice(0, 12)},收到 ${options.baseHash.slice(0, 12)});重新读一次再改`,
        );
      }
      const next = merge(before);
      if (projectHash(readProject(dir)) !== projectHash(before)) continue;
      // 写之前再认一次手:锁文件要是被人删掉/替掉了,宁可回 PROJECT_BUSY 也不按旧快照落盘。
      assertOwned();
      writeProject(dir, next);
      return next;
    }
    throw new VidroomError('PROJECT_BUSY', `同一条工程被反复改写(试了 ${UPDATE_ATTEMPTS} 次),先停手再试:${dir}`);
  });
}

/**
 * 上面那个复核循环的上限:撞这么多次就不是运气差,是有别的写者在反复刷。
 */
const UPDATE_ATTEMPTS = 5;

/** 等锁的上限与步长:40 × 5ms = 200ms —— 锁内只有同步的读/算/写,正常毫秒级就放。 */
const LOCK_TRIES = 40;
const LOCK_WAIT_MS = 5;

/** 让出 LOCK_WAIT_MS 毫秒再重试(同步等,不把调用点染成 async)。 */
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

/** 锁文件就放在工程文件旁边(测试夹具之外的写者都会碰它)。 */
export function lockFileOf(dir: string): string {
  return `${projectFileOf(dir)}.lock`;
}

/**
 * 拿到工程写锁再跑 `run`。
 *
 * 为什么不是内存锁:`writeProject` 的「读-改-写」跨进程也成立 —— dsh 容器里的面板、机器人进程里的
 * CLI、被面板拉起的渲染回写,是三个不同的进程,内存锁只挡得住其中一个。`open(…, O_EXCL)` 是
 * 文件系统给的原子占位,同一个锁名只有一个写者建得成,失败方等一小会儿。
 *
 * **不自动回收旧锁**(这是取舍,不是省事):回收一个「看着像废锁」的锁必须先看后删(先读它的内容与年龄,
 * 再决定删不删),那两步之间锁可能已经换了主 —— 持有者自己放掉、别人刚占上,删下去删的就是别人的活锁,
 * 那正好就是两个写者同时落盘。要真判「主人还活着吗」得靠内核给的锁(`flock` 一类),
 * Node 核心的 `fs` 没有这个接口(凭记忆,未核官方文档)。git 对自己的 `index.lock` 同样是
 * 「不回收、报错让人确认后手删」的做法(凭记忆,未核官方文档)。
 * 代价:**持有者崩溃会留下锁,这条工程在有人手删之前写不进去**;报错里给锁路径、写它的进程与躺了多久,
 * 替人省下「去猜该不该删」的那一步。
 *
 * 锁文件里写的是 `<令牌> <pid>`:令牌用来认自己(释放只删自己那把);pid 只给报错时看。
 * `run` 拿到一个 `assertOwned`(写进盘之前调一次):锁文件被人手工删掉/替掉时,宁可回 `PROJECT_BUSY`
 * 也不往下写。
 *
 * **这一步是尽量,不是安全边界**:它自己也是「先看后写」,看与写之间锁还能被换掉。它挡的是
 * 「误删了锁文件、本进程接着按旧快照写」这种自伤;挡不住一个专门在外面删/替锁的进程 ——
 * 那种对手要的是内核级的互斥(`flock`),本批不做,现状是「不守规矩的写者,结果由它自己负责」。
 */
export function withProjectLock<T>(dir: string, run: (assertOwned: () => void) => T): T {
  const lock = lockFileOf(dir);
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  acquireLock(dir, lock, token);
  try {
    return run(() => assertOwned(lock, token));
  } finally {
    releaseLock(lock, token);
  }
}

/**
 * 锁文件的一次观察:里面的令牌与 pid(可能读不出来)+ 它躺了多久。
 *
 * 内容读不出来不算错:占位成功、写内容之前进程就没了,就是这个形态。这种锁不会自动被清,
 * 但报错里要能说出来,让人知道该删的是它。
 */
type LockView = { token?: string; pid?: number; mtimeMs: number };

function viewLock(file: string): LockView | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  try {
    const [token, rawPid] = readFileSync(file, 'utf8').trim().split(/\s+/);
    if (token !== undefined && token !== '') {
      const pid = Number.parseInt(rawPid ?? '', 10);
      return { token, pid: Number.isInteger(pid) && pid > 0 ? pid : undefined, mtimeMs };
    }
  } catch {
    // 读不出来就当没主人:上面那种「建了一半」的锁。
  }
  return { mtimeMs };
}

/** 我这把锁还在不在自己手里 —— 不在就不能往下写(回 `PROJECT_BUSY`,让人重来)。 */
function assertOwned(lock: string, token: string): void {
  if (viewLock(lock)?.token !== token) {
    throw new VidroomError(
      'PROJECT_BUSY',
      `手里这把工程写锁已经不再指向我了(锁文件被人删掉或换成了别的),这次不写:${lock}`,
    );
  }
}

/**
 * 放锁:只在「读到的就是我的令牌」时删。
 *
 * 读不出内容、或读到别人的令牌,都什么都不动 —— 那一刻按路径删一个文件,删掉的可能是别人占着的位。
 * 自己的锁不会是这个形态(里面就是我刚写进去的令牌)。`ENOENT` 当成已经被清过。
 */
function releaseLock(lock: string, token: string): void {
  if (viewLock(lock)?.token !== token) return;
  try {
    unlinkSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new VidroomError('IO_ERROR', `工程写锁没清掉(${(error as Error).message}):${lock}`);
  }
}

/** 锁被谁占着、躺了多久 —— 只给人看,不作任何「要不要清掉」的判断。 */
function holderHint(lock: string): string {
  const view = viewLock(lock);
  if (view === undefined) return '';
  const minutes = Math.round((Date.now() - view.mtimeMs) / 60_000);
  const holder =
    view.token === undefined
      ? '里面没有内容(多半是上次崩在写入中间)'
      : view.pid === undefined
        ? `令牌 ${view.token},pid 读不出数`
        : `写它的进程令牌 ${view.token}(pid ${view.pid})`;
  return `。这把锁是「${holder}」留下的,躺了约 ${minutes} 分钟 —— 确认没人在写就删掉它再来`;
}

/**
 * 占位:`wx` 就是 `O_CREAT | O_EXCL` —— 同一个锁名只有一个写者建得成,这是文件系统给的原子检查。
 *
 * 整份内容(`<令牌> <pid>`)一次写进去、写完自己关:不去手动拿 fd 逐个收尾 ——
 * 短写由 Node 内部补完,也不用担心「关 fd 抛错把清理那一步跳过」留下内容不全的锁。
 * 真没写成(盘满、权限变),把自己刚建的那个残件收掉再报错。
 */
function createLockFile(lock: string, token: string): boolean {
  try {
    writeFileSync(lock, `${token} ${process.pid}\n`, { flag: 'wx', encoding: 'utf8' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // 只有「占位成功了、内容没写成」才会留下残件,而这个残件一定是我刚建的(建的那一步是原子的):
    // 收掉它。没建成的话这一下就是 ENOENT,没什么可收。
    try {
      unlinkSync(lock);
    } catch {
      // 没留下东西,或清理也失败了:报错更重要,不在这儿纠缠。
    }
    throw new VidroomError('IO_ERROR', `工程写锁没写成(${(error as Error).message}),这次不写:${lock}`);
  }
}

/**
 * 占位:失败方等一小会儿重试,到期就抛 `PROJECT_BUSY`。
 *
 * 不抢旧锁(为什么见 `withProjectLock` 的说明):抢锁要先看后删,那两步之间锁可能换主,
 * 删下去删的就是别人的活锁。所以这里只有「占上」与「等」两种结果,绝不空着手进临界区。
 */
function acquireLock(dir: string, lock: string, token: string): void {
  ensureDir(dir);
  for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
    if (createLockFile(lock, token)) return;
    sleepMs(LOCK_WAIT_MS);
  }
  throw new VidroomError(
    'PROJECT_BUSY',
    `工程正被另一个写者占着(${LOCK_TRIES * LOCK_WAIT_MS}ms 内没拿到锁),停一下再试:${lock}${holderHint(lock)}`,
  );
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

