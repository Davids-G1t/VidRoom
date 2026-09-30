import { resolveComfyInstall, type ComfyInstall, type ResolveOptions } from './install.js';
import { ComfyProcess } from './process.js';
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
          this.current = { state: 'error', message: `ComfyUI 意外退出:\n${proc.output().slice(-2_000)}` };
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
