import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ComfyInstall } from './install.js';
import type { SystemStats } from './versions.js';

/**
 * Host 管的 ComfyUI 子进程。
 *
 * - 只绑 127.0.0.1(`--listen 127.0.0.1`),端口每次现取一个空闲的;`--disable-auto-launch` 不让它自己开浏览器。
 * - 起来后轮询 /system_stats,拿到 200 才算就绪。
 * - 不直接跑 main.py,而是用一小段引导代码(BOOTSTRAP)包一层:它开一个线程一直读 stdin,
 *   stdin 一断(Host 退出、崩溃、被强杀,管道都会断)就先模拟 Ctrl+C 让 ComfyUI 走自己的退出流程,
 *   GRACE 秒后还没退就 os._exit。**这是 Host 自身退出(CLI 下 kill、崩溃)时的防护路径**——
 *   Windows 桌面版走的是另一条路:Electron 退出时把 ComfyUI 所在的 Windows 作业对象
 *   (job object)连带强杀,这条路径更快、先于 stdin 检测生效,结果同样是不留孤儿,
 *   但走的不是这里描述的「模拟 Ctrl+C 优雅退出」,而是直接强杀(见 codereview 第3a批 F3)。
 *
 * 停止(stop):
 * - ComfyUI v0.38.0 没有「关闭服务」的 HTTP 接口(路由里只有 /interrupt 打断当前任务、/free 释放显存),
 *   也没装 SIGTERM 处理器 —— SIGTERM 会让 Python 直接死掉,不走任何清理;
 *   它的正常退出路径是 Ctrl+C(SIGINT → KeyboardInterrupt → 打印 "Stopped server",再关资产管理器)。
 * - Linux:给整个进程组发 SIGINT,等 GRACE 秒,不退再 SIGKILL。
 * - Windows:没有 SIGINT/SIGTERM 可发(Node 的 kill() 在 Windows 上就是 TerminateProcess 强杀,
 *   test/comfyui-process.test.ts 在 CI 上实测)。这里改成关 stdin,由引导代码在进程内模拟 Ctrl+C;
 *   GRACE 秒不退,引导代码自己 os._exit(WATCHDOG_EXIT_CODE),再不退 Host 用 `taskkill /T /F` 连子进程一起强杀。
 *   进程内模拟的 Ctrl+C 能不能真把 ComfyUI 的事件循环叫醒,以 CI 实测日志里有没有 "Stopped server" 为准;
 *   stop() 的返回值如实报告是 ComfyUI 自己退出的还是兜底杀掉的。
 */

export const COMFY_LISTEN_HOST = '127.0.0.1';
export const STOP_GRACE_MS = 10_000;
/** 引导代码等不到 ComfyUI 自己退出、只好 os._exit 时用的退出码,用来和「正常退出」区分 */
export const WATCHDOG_EXIT_CODE = 86;
/** Windows 上 ComfyUI 内存超过作业对象上限、被整组结束时的退出码 */
export const MEMORY_LIMIT_EXIT_CODE = 87;
/** 传给 ComfyUI 进程的内存上限(MiB);引导代码读它建作业对象。只在 Windows 上生效 */
export const JOB_MEMORY_LIMIT_ENV = 'VIDROOM_JOB_MEMORY_LIMIT_MB';

/**
 * Windows 内存护栏(引导代码里用 ctypes 调 Win32 API,不需要原生 Node 模块):
 * 设了 VIDROOM_JOB_MEMORY_LIMIT_MB 就建一个作业对象(Job Object),设 JOB_OBJECT_LIMIT_JOB_MEMORY
 * 把 ComfyUI 进程(和它以后起的子进程)放进去,再挂一个完成端口收通知。整组提交内存超过上限时,
 * 系统拒绝那次分配并发来 JOB_OBJECT_MSG_JOB_MEMORY_LIMIT / _PROCESS_MEMORY_LIMIT,
 * 监视线程收到就 TerminateJobObject(退出码 MEMORY_LIMIT_EXIT_CODE)—— 只结束 ComfyUI 这一组,
 * Host 不在这个作业里,不受影响。建作业之前(解释器刚启动)的那一点内存不受限,可忽略。
 */
const JOB_MEMORY_GUARD = [
  'def _job_memory_guard():',
  `    mb = int(os.environ.get('${JOB_MEMORY_LIMIT_ENV}') or 0)`,
  "    if os.name != 'nt' or mb <= 0:",
  '        return',
  '    import ctypes',
  '    from ctypes import wintypes',
  "    k32 = ctypes.WinDLL('kernel32', use_last_error=True)",
  '    k32.CreateJobObjectW.restype = wintypes.HANDLE',
  '    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]',
  '    k32.CreateIoCompletionPort.restype = wintypes.HANDLE',
  '    k32.CreateIoCompletionPort.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.c_size_t, wintypes.DWORD]',
  '    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]',
  '    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]',
  '    k32.GetCurrentProcess.restype = wintypes.HANDLE',
  '    k32.TerminateJobObject.argtypes = [wintypes.HANDLE, ctypes.c_uint]',
  '    k32.GetQueuedCompletionStatus.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_void_p), wintypes.DWORD]',
  '    class BASIC(ctypes.Structure):',
  "        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_int64), ('PerJobUserTimeLimit', ctypes.c_int64), ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t), ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD), ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]",
  '    class IO(ctypes.Structure):',
  "        _fields_ = [(n, ctypes.c_ulonglong) for n in ('ReadOps', 'WriteOps', 'OtherOps', 'ReadBytes', 'WriteBytes', 'OtherBytes')]",
  '    class EXT(ctypes.Structure):',
  "        _fields_ = [('Basic', BASIC), ('Io', IO), ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]",
  '    class PORT(ctypes.Structure):',
  "        _fields_ = [('CompletionKey', ctypes.c_void_p), ('CompletionPort', wintypes.HANDLE)]",
  '    job = k32.CreateJobObjectW(None, None)',
  '    port = k32.CreateIoCompletionPort(wintypes.HANDLE(-1), None, 0, 1)',
  '    assoc = PORT(None, port)',
  // JobObjectAssociateCompletionPortInformation = 7;JobObjectExtendedLimitInformation = 9;JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200
  '    ok = job and port and k32.SetInformationJobObject(job, 7, ctypes.byref(assoc), ctypes.sizeof(assoc))',
  '    ext = EXT()',
  '    ext.Basic.LimitFlags = 0x200',
  '    ext.JobMemoryLimit = mb * 1024 * 1024',
  '    ok = ok and k32.SetInformationJobObject(job, 9, ctypes.byref(ext), ctypes.sizeof(ext))',
  '    ok = ok and k32.AssignProcessToJobObject(job, k32.GetCurrentProcess())',
  '    if not ok:',
  "        sys.stderr.write('[vidroom] 建内存上限作业对象失败,错误码 %d,ComfyUI 不受内存上限保护\\n' % ctypes.get_last_error())",
  '        return',
  "    sys.stderr.write('[vidroom] ComfyUI 内存上限 %d MiB(Windows 作业对象)\\n' % mb)",
  '    def _watch_job():',
  '        msg = wintypes.DWORD(); key = ctypes.c_size_t(); ov = ctypes.c_void_p()',
  '        while k32.GetQueuedCompletionStatus(port, ctypes.byref(msg), ctypes.byref(key), ctypes.byref(ov), 0xFFFFFFFF):',
  // JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT = 9、JOB_OBJECT_MSG_JOB_MEMORY_LIMIT = 10
  '            if msg.value in (9, 10):',
  "                sys.stderr.write('[vidroom] ComfyUI 内存超过上限 %d MiB,结束 ComfyUI\\n' % mb)",
  '                sys.stderr.flush()',
  `                k32.TerminateJobObject(job, ${MEMORY_LIMIT_EXIT_CODE})`,
  '    threading.Thread(target=_watch_job, daemon=True).start()',
  '_job_memory_guard()',
];

export const BOOTSTRAP = [
  'import os, signal, sys, threading, time, _thread',
  ...JOB_MEMORY_GUARD,
  'def _wait_stdin_closed():',
  "    if os.name == 'nt':",
  // Windows 上不能在线程里阻塞读 stdin:同步管道句柄上挂着一个 ReadFile 时,别的线程对同一句柄的操作
  // (如查句柄类型)会一起卡住。改为每半秒 PeekNamedPipe 看一眼,管道断了它就返回失败。
  '        import ctypes, msvcrt',
  '        from ctypes import wintypes',
  '        h = wintypes.HANDLE(msvcrt.get_osfhandle(0))',
  '        n = wintypes.DWORD()',
  '        while ctypes.windll.kernel32.PeekNamedPipe(h, None, 0, None, ctypes.byref(n), None):',
  '            time.sleep(0.5)',
  '    else:',
  // 读原始 fd,不读 sys.stdin:解释器正常退出时,守护线程卡在 BufferedReader 的锁上会让 Python 以 SIGABRT 崩掉
  '        while os.read(0, 65536):',
  '            pass',
  'def _watch():',
  '    try:',
  '        _wait_stdin_closed()',
  '    except Exception:',
  '        pass',
  // 模拟 Ctrl+C。Linux 上 interrupt_main() 叫不醒 ComfyUI 阻塞在 select 里的事件循环(实测要等到 os._exit 兜底),
  // 给自己发真 SIGINT 才行;Windows 上 os.kill(SIGINT) 等于 TerminateProcess,只能用 interrupt_main()
  "    _thread.interrupt_main() if os.name == 'nt' else os.kill(os.getpid(), signal.SIGINT)",
  `    time.sleep(${STOP_GRACE_MS / 1000})`,
  `    os._exit(${WATCHDOG_EXIT_CODE})`,
  'threading.Thread(target=_watch, daemon=True).start()',
  // 排障用:设了 VIDROOM_COMFYUI_DUMP_STACKS_AFTER=<秒>,到时还在跑就把所有线程的调用栈打到 stderr(之后每隔这么久再打一次)
  "if os.environ.get('VIDROOM_COMFYUI_DUMP_STACKS_AFTER'):",
  '    import faulthandler',
  "    faulthandler.dump_traceback_later(int(os.environ['VIDROOM_COMFYUI_DUMP_STACKS_AFTER']), repeat=True, file=sys.stderr)",
  'main = os.path.abspath(sys.argv[1])',
  'sys.argv = [main] + sys.argv[2:]',
  'sys.path.insert(0, os.path.dirname(main))',
  'os.chdir(os.path.dirname(main))',
  'import runpy',
  "runpy.run_path(main, run_name='__main__')",
].join('\n');

export interface ComfyStartOptions {
  install: ComfyInstall;
  /** 额外的 ComfyUI 参数,比如 ['--cpu'] */
  extraArgs?: string[];
  readyTimeoutMs?: number;
  /** 等就绪期间收到中止就停掉进程、抛错 */
  signal?: AbortSignal;
  log?: (msg: string) => void;
  /** Windows:ComfyUI 整组进程的内存上限(MiB),超了只结束 ComfyUI。不给或 ≤0 不设上限;其它平台忽略 */
  memoryLimitMiB?: number;
}

export interface StopResult {
  /** true = ComfyUI 在宽限期内自己正常退出(退出码 0;不是被 SIGKILL/taskkill 强杀,也不是引导代码 os._exit 兜底) */
  graceful: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, COMFY_LISTEN_HOST, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export class ComfyProcess {
  private out = '';
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  readonly exited: Promise<void>;

  private constructor(
    private readonly child: ChildProcess,
    readonly port: number,
  ) {
    const keep = (d: Buffer) => {
      this.out = (this.out + d.toString()).slice(-64_000);
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    this.exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        resolve();
      }),
    );
    // stdin 只用来让子进程感知 Host 还活着,不写东西;管道出错(子进程已退)不要让 Host 崩
    child.stdin!.on('error', () => {});
  }

  get pid(): number {
    return this.child.pid!;
  }

  get url(): string {
    return `http://${COMFY_LISTEN_HOST}:${this.port}`;
  }

  get running(): boolean {
    return this.exitInfo === null;
  }

  /** 退出码(还在跑是 undefined) */
  get exitCode(): number | null | undefined {
    return this.exitInfo?.code;
  }

  /** 最近的输出(最多约 64KB) */
  output(): string {
    return this.out;
  }

  static async start(opts: ComfyStartOptions): Promise<ComfyProcess> {
    const log = opts.log ?? (() => {});
    const port = await freePort();
    const args = [
      '-s',
      '-c',
      BOOTSTRAP,
      join(opts.install.comfyDir, 'main.py'),
      '--listen',
      COMFY_LISTEN_HOST,
      '--port',
      String(port),
      '--disable-auto-launch',
      ...(opts.extraArgs ?? []),
    ];
    const child = spawn(opts.install.python, args, {
      cwd: opts.install.comfyDir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        [JOB_MEMORY_LIMIT_ENV]: opts.memoryLimitMiB && opts.memoryLimitMiB > 0 ? String(Math.floor(opts.memoryLimitMiB)) : '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Linux 上自成一个进程组,停的时候连它的子进程一起发信号
      detached: process.platform !== 'win32',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const proc = new ComfyProcess(child, port);
    log(`[comfyui] 已启动 pid=${child.pid},端口 ${port}`);
    try {
      await proc.waitReady(opts.readyTimeoutMs ?? 180_000, opts.signal);
    } catch (err) {
      await proc.stop();
      throw err;
    }
    log(`[comfyui] 就绪:${proc.url}`);
    return proc;
  }

  async systemStats(timeoutMs = 5_000): Promise<SystemStats> {
    const res = await fetch(`${this.url}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`/system_stats 返回 HTTP ${res.status}`);
    return (await res.json()) as SystemStats;
  }

  private async waitReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (!this.running) {
        throw new Error(`ComfyUI 启动途中退出(code=${this.exitInfo?.code} signal=${this.exitInfo?.signal}):\n${this.out.slice(-4_000)}`);
      }
      try {
        await this.systemStats(2_000);
        return;
      } catch {
        await sleep(500);
      }
    }
    throw new Error(`ComfyUI ${Math.round(timeoutMs / 1000)} 秒内没有就绪:\n${this.out.slice(-16_000)}`);
  }

  async stop(graceMs = STOP_GRACE_MS): Promise<StopResult> {
    if (this.running) {
      if (process.platform === 'win32') {
        this.child.stdin!.end();
      } else {
        signalGroup(this.pid, 'SIGINT');
      }
    }
    const timer = new AbortController();
    const exitedInTime = await Promise.race([
      this.exited.then(() => true),
      sleep(graceMs + 2_000, false, { signal: timer.signal }).catch(() => false),
    ]);
    timer.abort();
    if (!exitedInTime) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true });
      } else {
        signalGroup(this.pid, 'SIGKILL');
      }
      await this.exited;
    }
    this.child.stdin!.destroy();
    const info = this.exitInfo!;
    return { graceful: exitedInTime && info.code === 0, ...info };
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // 进程组已经没了
  }
}
