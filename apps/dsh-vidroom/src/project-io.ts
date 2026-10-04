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

/** 锁文件里的内容:`<令牌> <pid>`(内容与同一性的读法见 `viewLock`)。 */
/**
 * 那个 pid 还活着吗。只有 `ESRCH` 算死;`EPERM` 是活着但不同用户,一样算活。
 * pid 读不出来(-1)算「说不清」,不当死处理 —— 宁可知难而退报忙,也不抢一把不知道主人的锁。
 *
 * 前提(不是保证,是这条实现依赖的部署事实):写者都在同一个 PID 命名空间里 —— 本批就是
 * 插件、面板 HTTP、渲染回写都跑在同一个 dsh 容器里。哪天有了跨命名空间的写者,
 * `kill(pid, 0)` 会认不出那个活进程,「不许抢活锁」这条就不成立;那时要么别跳命名空间写,
 * 要么换 `flock` 这类由内核判归属的锁(本仓现在没有,Node 核心也没暴露)。
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

/** 锁文件的一次观察:内容(可能没主人)+ 它的同一性(dev/ino/mtime)。 */
type LockView = { token?: string; pid?: number; dev: number; ino: number; mtimeMs: number };

function viewLock(file: string): LockView | undefined {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return undefined;
  }
  const view: LockView = { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  try {
    const [token, rawPid] = readFileSync(file, 'utf8').trim().split(/\s+/);
    if (token !== undefined && token !== '') {
      const pid = Number.parseInt(rawPid ?? '', 10);
      return { ...view, token, pid: Number.isInteger(pid) ? pid : -1 };
    }
  } catch {
    // 读不出来就当没主人(建了一半就崩了):同一性还是要留着的。
  }
  return view;
}

/** 两次观察说的是不是同一把锁 —— dev/ino/mtime 三重,免得把别人刚建的锁当废锁搬走。 */
function sameLock(a: LockView, b: LockView): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
}

/**
 * 算不算「废锁」:年龄超过 `LOCK_STALE_MS`,**而且**写锁那个进程已经没了。
 *
 * ②是关键:只要持有者还活着,哪怕它卡了 30 秒也不抢 —— 「看完再删」这类写法真正的坑是
 * 「看的时候还废着、删的时候那把已经换成新持有者的活锁」。没主人(建了一半就崩、
 * 别的工具写的)也算废:它没写成功过,谁也认不出它;要真有个卡在 open 与写入之间的写者,
 * 它落盘前的 `assertOwned` 也会发现路径上不是自己的令牌,不会写。
 */
function staleEnough(view: LockView): boolean {
  if (Date.now() - view.mtimeMs <= LOCK_STALE_MS) return false;
  if (view.token === undefined) return true;
  return view.pid !== undefined && !pidAlive(view.pid);
}

/** 我这把锁还在不在自己手里 —— 不在就不能往下写(回 `PROJECT_BUSY`,让人重来)。 */
function assertOwned(lock: string, token: string): void {
  if (viewLock(lock)?.token !== token) {
    throw new VidroomError(
      'PROJECT_BUSY',
      `这条工程的写锁已经换手(多半是本进程被卡住、锁被当成废锁清了),这次不写:${lock}`,
    );
  }
}

/**
 * 放锁:只在「读到的就是我的令牌」时删。
 *
 * 读不出内容(新持有者刚 `O_EXCL` 建好、还没写进去)或读到别人的令牌,都什么都不动 ——
 * 那一刻按路径删一个文件,删掉的可能是别人刚占上的位。放不掉自己那把只是让锁晚一点被回收
 * (过期 + 我的 pid 没了),比替别人开门强。`ENOENT` 当成已经被清过。
 */
function releaseLock(lock: string, token: string): void {
  if (viewLock(lock)?.token !== token) return;
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
 * 清掉一把废锁:只看一次、只搬一次。
 *
 * `rename` 是原子的:同一把废锁只有一个抢锁者能搬走。搬到手之后再拿「同一性」
 * (dev/ino/mtime)核对搬的确实是我刚才看的那把 —— 万一这中间持有者自己放掉、别人又建了新的活锁,
 * 核对就不通过,原样放回去。核对通过才删。
 *
 * 返回 `true` 只表示「这把废锁我清掉了」,不表示「我拿到锁了」—— 占位永远要重新 `O_EXCL`。
 */
function clearStaleLock(lock: string, token: string): boolean {
  const seen = viewLock(lock);
  if (seen === undefined || !staleEnough(seen)) return false;
  const claim = `${lock}.stale-${token}`;
  try {
    renameSync(lock, claim);
  } catch {
    // 别人先搬走,或持有者自己放掉了:下一轮重来。
    return false;
  }
  const grabbed = viewLock(claim);
  if (grabbed === undefined || !sameLock(seen, grabbed)) {
    // 搬错了手(这中间锁换过主):原样放回去。
    try {
      renameSync(claim, lock);
    } catch {
      // 放不回去 = 这期间又有写者占了位:把这把丢掉(它的 `assertOwned` 会拦住它写)。
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
 * 占位,成不成就在这一下:`O_EXCL` 建出来就是我的。
 *
 * 建出来之后内容写不进去 = 这个壳我不要了,当场清掉再报错:留个没主人的空壳在后面能靠
 * 「过期 + 没主人」回收,但那要等 `LOCK_STALE_MS`,不如自己收干净。
 */
function createLockFile(lock: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, `${token} ${process.pid}\n`);
  } catch (error) {
    try {
      unlinkSync(lock);
    } catch {
      // 壳已经没了。
    }
    throw new VidroomError(
      'IO_ERROR',
      `工程写锁占上了但写不进内容(${(error as Error).message}),这次不写:${lock}`,
    );
  } finally {
    try {
      closeSync(fd);
    } catch {
      // fd 关不掉:壳里已经是我的令牌,走正常的过期回收。
    }
  }
  return true;
}

/**
 * 占位:失败方等一小会儿重试;只有「年龄过期 + 持有者已死」的废锁才清。
 *
 * 清的写法是「清掉旧的,下一轮重新 `O_EXCL` 占位」—— 不把「清掉」当成「拿到」:清完到占位
 * 之间还可能有别的写者插进来,那也应该让它先。`for` 跑完还没拿到就抛 `PROJECT_BUSY`,
 * 绝不空着手进临界区。
 */
function acquireLock(dir: string, lock: string, token: string): void {
  ensureDir(dir);
  for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
    if (createLockFile(lock, token)) return;
    if (clearStaleLock(lock, token)) continue;
    sleepMs(LOCK_WAIT_MS);
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

