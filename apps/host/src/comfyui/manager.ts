import { resolveComfyInstall, type ComfyInstall, type ResolveOptions } from './install.js';
import { ComfyProcess, MEMORY_LIMIT_EXIT_CODE } from './process.js';
import { checkVersions, type VersionCheck } from './versions.js';

/** 给页面和 agent 看的 ComfyUI 状态 */
export type ComfyStatus =
  | { state: 'stopped' }
  | { state: 'installing'; phase: 'downloading' | 'extracting'; received?: number; total?: number }
  | { state: 'starting' }
  | { state: 'running'; port: number; url: string; devices: string[]; versions: VersionCheck }
  | { state: 'error'; message: string };

export interface ComfyManagerOptions {
  resolveInstall?: (opts: ResolveOptions) => Promise<ComfyInstall>;
  /** 额外的 ComfyUI 参数(如 --cpu),来自 VIDROOM_COMFYUI_ARGS */
  extraArgs?: string[];
  readyTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Windows:ComfyUI 的内存上限(MiB),见 process.ts 的作业对象护栏 */
  memoryLimitMiB?: number;
}

/**
 * ComfyUI 生命周期:第一次 start() 时按平台找到(Windows 上必要时下载)ComfyUI,起子进程,等就绪。
 * start() 可重复调用(已在装/在起/在跑就什么都不做);stop() 会中止正在进行的下载或启动。
 */
export class ComfyManager {
  private proc: ComfyProcess | null = null;
  private current: ComfyStatus = { state: 'stopped' };
  private starting: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(private readonly opts: ComfyManagerOptions = {}) {}

  status(): ComfyStatus {
    return this.current;
  }

  /** 正在跑的进程(没有就是 null) */
  get process(): ComfyProcess | null {
    return this.proc;
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.proc?.running) return Promise.resolve();
    const abort = new AbortController();
    this.abort = abort;
    const log = this.opts.log ?? console.log;
    this.current = { state: 'starting' };
    this.starting = (async () => {
      try {
        const install = await (this.opts.resolveInstall ?? resolveComfyInstall)({
          signal: abort.signal,
          log,
          onProgress: (p) => (this.current = { state: 'installing', ...p }),
        });
        abort.signal.throwIfAborted();
        this.current = { state: 'starting' };
        const proc = await ComfyProcess.start({
          install,
          extraArgs: this.opts.extraArgs,
          readyTimeoutMs: this.opts.readyTimeoutMs,
          signal: abort.signal,
          log,
          memoryLimitMiB: this.opts.memoryLimitMiB,
        });
        this.proc = proc;
        const stats = await proc.systemStats();
        const versions = checkVersions(stats);
        for (const p of versions.problems) log(`[comfyui] 版本检查不通过:${p}`);
        this.current = {
          state: 'running',
          port: proc.port,
          url: proc.url,
          devices: stats.devices.map((d) => d.name),
          versions,
        };
        void proc.exited.then(() => {
          if (this.proc !== proc) return;
          this.proc = null;
          const why =
            proc.exitCode === MEMORY_LIMIT_EXIT_CODE
              ? `ComfyUI 内存超过上限(${this.opts.memoryLimitMiB} MiB)被结束,VidRoom 本身不受影响`
              : 'ComfyUI 意外退出';
          log(`[comfyui] ${why}(退出码 ${proc.exitCode})`);
          this.current = { state: 'error', message: `${why}:\n${proc.output().slice(-2_000)}` };
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const half = this.proc;
        this.proc = null;
        if (half) await half.stop();
        if (!abort.signal.aborted) log(`[comfyui] 启动失败:${message}`);
        this.current = abort.signal.aborted ? { state: 'stopped' } : { state: 'error', message };
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.starting;
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      const r = await proc.stop();
      (this.opts.log ?? console.log)(
        `[comfyui] 已停止 pid=${proc.pid}:${r.graceful ? '自己退出' : '强杀'}(code=${r.code} signal=${r.signal})`,
      );
    }
    this.current = { state: 'stopped' };
  }
}

/** VIDROOM_COMFYUI_ARGS="--cpu --foo" → ['--cpu', '--foo'] */
export function parseExtraArgs(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/).filter(Boolean);
}

/**
 * ComfyUI 内存上限默认值(只在 Windows 上生效):物理内存减去给系统、Host 和桌面壳留的 4 GiB,至少 4 GiB。
 * 可用环境变量 VIDROOM_COMFYUI_MEMORY_LIMIT_MB 改;设 0 表示不设上限。
 */
export const MEMORY_LIMIT_ENV = 'VIDROOM_COMFYUI_MEMORY_LIMIT_MB';
export function defaultMemoryLimitMiB(totalBytes: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[MEMORY_LIMIT_ENV];
  if (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v))) return Math.max(0, Math.floor(Number(v)));
  return Math.max(4096, Math.floor(totalBytes / 2 ** 20) - 4096);
}
