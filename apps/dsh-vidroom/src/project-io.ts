/**
 * 工程的落盘与改写:读/写 `project.vr.json`、安全解析工程内路径、导入本地素材、
 * 白名单 patch。
 *
 * 两条硬线:①工程内的资源一律相对路径且不许越出工程根(含符号链接);
 * ②patch 只走白名单,任何试图改边界字段(policy / budget / assets / candidates …)的
 * patch 都直接拒掉 —— 不接受任意代码 patch。
 *
 * 写入口只有三个、不许旁路:`writeProject`(整份写,给夹具/测试)、`updateProject`(锁内读-改-写一条)、
 * `applyPatch`(白名单 patch 的纯函数:只算出新工程,不落盘;`baseHash` 的核对在 `updateProject` 里)。
 * **除夹具外一律走 `updateProject`** —— 它是唯一带跨进程互斥与乐观复核的写路径。
 */

import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
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
 * 两道防:①**跨进程文件锁**(`.project.vr.json.lock`)—— 别的前端(dsh 容器里的面板、CLI、另一个
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
      // 写之前再认一次手:锁要是中途被抢走(本进程卡太久),宁可回 PROJECT_BUSY 也不按旧快照落盘。
      assertOwned();
      writeProject(dir, next);
      return next;
    }
    throw new VidroomError('PROJECT_BUSY', `同一条工程被反复改写(试了 ${UPDATE_ATTEMPTS} 次),先停手再试:${dir}`);
  });
}

/** 上面那个复核循环的上限:撞这么多次就不是运气差,是有别的写者在反复刷。 */
const UPDATE_ATTEMPTS = 5;

/** 等锁的上限与步长:40 × 5ms = 200ms —— 锁内只有同步的读/算/写,正常毫秒级就放。 */
const LOCK_TRIES = 40;
const LOCK_WAIT_MS = 5;
/** 持有者崩了会留下锁文件;超过这么久没动就算废锁,后来者抢过来继续干活。 */
const LOCK_STALE_MS = 30_000;

/** 本进程已持有的锁(同一进程内读-改-写嵌一层时不至于自己把自己锁死)。键是锁文件,值是我写进去的令牌。 */
const heldLocks = new Map<string, string>();

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
 * 文件系统给的原子占位,失败方等一小会儿;持有者崩了(锁文件没人管了)靠「年龄 + pid 已死」判废锁,
 * 不会永久卡死。
 *
 * 锁文件里写的是 `<令牌> <pid>`:令牌用来认自己 —— 释放与「我还持有吗」都靠它,废锁被抢走后
 * 原来的持有者不会再删别人的锁;pid 用来判持有者死活 —— 只要它还活着,哪怕卡了 30 秒也不抢。
 * `run` 拿到一个 `assertOwned`(写进盘之前调一次):自己那把锁中途被抢走时,宁可回 `PROJECT_BUSY`
 * 也不往下写 —— 这一步是保底:哪怕锁文件被人手工删了、没了,也不可能两个写者同时落盘。
 */
export function withProjectLock<T>(dir: string, run: (assertOwned: () => void) => T): T {
  const lock = lockFileOf(dir);
  const held = heldLocks.get(lock);
  // 重入:外面那层已经把进程内的写者排完队了。
  if (held !== undefined) return run(() => assertOwned(lock, held));
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  acquireLock(dir, lock, token);
  heldLocks.set(lock, token);
  try {
    return run(() => assertOwned(lock, token));
  } finally {
    heldLocks.delete(lock);
    releaseLock(lock, token);
  }
}

/** 锁文件里的内容:`<令牌> <pid>`。 */
function lockOwnerOf(lock: string): { token: string; pid: number } | undefined {
  try {
    const [token, rawPid] = readFileSync(lock, 'utf8').trim().split(/\s+/);
    if (token === undefined || token === '') return undefined;
    const pid = Number.parseInt(rawPid ?? '', 10);
    return { token, pid: Number.isInteger(pid) ? pid : -1 };
  } catch {
    return undefined;
  }
}

/**
 * 那个 pid 还活着吗。只有 `ESRCH` 算死;`EPERM` 是活着但不同用户,一样算活。
 * pid 读不出来(-1)算「说不清」,不当死处理 —— 宁可知难而退报忙,也不抢一把不知道主人的锁。
 * 前提:写者都在同一个 PID 命名空间里(本机就是:插件、面板、渲染回写都在同一个容器里)。
 */
function pidAlive(pid: number): boolean {
  if (pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 我这把锁还在不在自己手里 —— 不在就不能往下写(回 `PROJECT_BUSY`,让人重来)。 */
function assertOwned(lock: string, token: string): void {
  if (lockOwnerOf(lock)?.token !== token) {
    throw new VidroomError(
      'PROJECT_BUSY',
      `这条工程的写锁已经换手(多半是本进程被卡住、锁被当成废锁清了),这次不写:${lock}`,
    );
  }
}

/**
 * 放锁:只放自己那把。令牌对不上就什么都不动 —— 那把已经不属于我了,删它就是替新持有者开门。
 *
 * 只放过 `ENOENT`(锁已经被清理过)。其他错误(权限/IO)明着抛:那一刻写其实已经落盘,
 * 但锁会一直挡着后面的写者直到过期,不能装作没事 —— 报 `IO_ERROR` 让人去看。
 */
function releaseLock(lock: string, token: string): void {
  const owner = lockOwnerOf(lock);
  if (owner !== undefined && owner.token !== token) return;
  try {
    unlinkSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new VidroomError(
      'IO_ERROR',
      `工程写锁没清掉(${(error as Error).message}),后面的写者会被挡到 ${LOCK_STALE_MS}ms:${lock}`,
    );
  }
}

/**
 * 这把锁能不能抢?两条都要:①年龄超过 `LOCK_STALE_MS`(短临界区里这就是「持有者卡住了」的信号);
 * ②写锁那个进程已经没了(`kill(pid, 0)` 说 `ESRCH`)。
 *
 * ②是关键:只要持有者还活着,哪怕它卡了 30 秒也不抢 —— 「检查完再删」这类写法真正的坑是
 * 「检查时说它废了、删的时候那把已经换成了新持有者的活锁」;而一个活着的持有者根本不会被抢,
 * 那个窗口就无从发生。读不出主人(手工改过、别的工具写的)也不抢:报忙,让人自己看。
 */
function stealable(lock: string): boolean {
  const owner = lockOwnerOf(lock);
  if (owner === undefined || pidAlive(owner.pid)) return false;
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * 抢废锁:先把它整把 `rename` 到一个只我知道的名字下 —— `rename` 是原子的,同一把废锁
 * 只有一个人能抢到手,不存在两个抢锁者都以为自己拿到了。抢到之后再认一遍内容:万一拿到手的
 * 是别人刚建的活锁(它的 pid 还活着、令牌也不是我刚才看的那把),就原样放回去,不抢。
 *
 * 返回值只表示「这把废锁我清掉了,可以重试占位」,不表示「我拿到了锁」—— 占位永远要重新 `O_EXCL`。
 */
function stealStaleLock(lock: string, token: string): boolean {
  const seen = lockOwnerOf(lock);
  if (seen === undefined) return false;
  const claim = `${lock}.stale-${token}`;
  try {
    renameSync(lock, claim);
  } catch {
    // 别人先抢走,或持有者自己放掉了:下一轮重来。
    return false;
  }
  const grabbed = lockOwnerOf(claim);
  if (grabbed !== undefined && (grabbed.token !== seen.token || pidAlive(grabbed.pid))) {
    try {
      renameSync(claim, lock);
    } catch {
      // 放不回去 = 这期间又有写者占了位。它那把锁还在,`assertOwned` 会拦住它写;这把丢掉。
      try {
        unlinkSync(claim);
      } catch {
        // 已经没了。
      }
    }
    return false;
  }
  try {
    unlinkSync(claim);
  } catch {
    // 已经没了。
  }
  return true;
}

/**
 * 占位:失败方等一小会儿重试;只有「年龄过期 + 持有者已死」的废锁才抢。
 *
 * 抢的写法是「清掉旧的,下一轮重新 `O_EXCL` 占位」—— 不把「清掉」当成「拿到」:清完到占位
 * 之间还可能有别的写者插进来,那也应该让它先。`for` 跑完还没拿到就抛 `PROJECT_BUSY`,
 * 绝不空着手进临界区。
 */
function acquireLock(dir: string, lock: string, token: string): void {
  ensureDir(dir);
  for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
    try {
      const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      try {
        writeSync(fd, `${token} ${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (stealable(lock) && stealStaleLock(lock, token)) continue;
      sleepMs(LOCK_WAIT_MS);
    }
  }
  throw new VidroomError(
    'PROJECT_BUSY',
    `工程正被另一个写者占着(${LOCK_TRIES * LOCK_WAIT_MS}ms 内没拿到锁),停一下再试。` +
      `确认没人在写(比如上一次崩了)就删掉这个锁文件再来:${lock}`,
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

