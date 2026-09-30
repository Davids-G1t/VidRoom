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

const BOOTSTRAP = [
  'import os, signal, sys, threading, time, _thread',
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
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
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
