import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import type { ComfyManager } from '../comfyui/manager.js';
import type { GpuProbeResult } from '../gpu.js';
import { h3Admission, type Admission } from './admission.js';
import { ComfyClient, type ComfyProgress } from './comfy-client.js';
import { H3_FPS, framesForSeconds } from './frames.js';
import { H3_LICENSE, type ConsentRecord, type ConsentStore } from './license.js';
import type { VideoLibrary, VideoRecord } from './library.js';
import type { FileStatus, ModelFile, ModelStore } from './models.js';
import { buildPromptRequest } from './workflow.js';

/**
 * 出片服务:把「许可同意 → 补齐权重 → 准入 → 起 ComfyUI → 提交锁定模板 → 转发进度 → 成片入库」串起来。
 * 同一时间只跑一个任务。agent 的 generate_video 工具和页面的 /api/h3、/api/videos 接口都走这里。
 */

export const PROMPT_MIN_WORDS = 180;
export const PROMPT_MAX_WORDS = 260;
export const MAX_SECONDS = 15;

export type DownloadState =
  | { state: 'idle' }
  | { state: 'downloading'; file: string; received: number; total: number }
  | { state: 'done'; downloaded: string[] }
  | { state: 'error'; message: string };

export type JobState =
  | { state: 'idle' }
  | { state: 'preparing'; message: string }
  | { state: 'running'; node: string | null; value: number; max: number; startedAt: string }
  | { state: 'done'; videoId: string }
  | { state: 'error'; message: string }
  | { state: 'cancelled' };

export interface H3Status {
  license: typeof H3_LICENSE;
  consent: ConsentRecord | null;
  models: FileStatus[] | null;
  download: DownloadState;
  admission: Admission;
}

export type GenerateResult =
  | { ok: true; video: Omit<VideoRecord, 'file'> }
  | { ok: false; reason: string };

export interface VideoServiceOptions {
  comfy: ComfyManager;
  models: ModelStore;
  consent: ConsentStore;
  library: VideoLibrary;
  probeGpu: () => Promise<GpuProbeResult>;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  /** 采样显存/内存的间隔 */
  sampleMs?: number;
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** H3 提示词的硬性要求:英文散文、180–260 词。不合格就把原因回给 LLM 让它重写。 */
export function checkPrompt(prompt: string): string | null {
  if (/[　-鿿가-힯＀-￯]/.test(prompt)) return '提示词必须是英文(发现了中日韩文字),请改写成英文散文。';
  const n = countWords(prompt);
  if (n < PROMPT_MIN_WORDS || n > PROMPT_MAX_WORDS) {
    return `提示词有 ${n} 个英文单词,要求 ${PROMPT_MIN_WORDS}–${PROMPT_MAX_WORDS} 个,请改写后重新调用。`;
  }
  return null;
}

export class VideoService {
  private download: DownloadState = { state: 'idle' };
  private downloading: Promise<void> | null = null;
  private current: JobState = { state: 'idle' };
  private abort: AbortController | null = null;

  constructor(private readonly o: VideoServiceOptions) {}

  private get log() {
    return this.o.log ?? console.log;
  }

  get busy(): boolean {
    return this.abort !== null;
  }

  job(): JobState {
    return this.current;
  }

  async status(opts: { inspectModels?: boolean } = {}): Promise<H3Status> {
    const gpu = await this.o.probeGpu();
    return {
      license: H3_LICENSE,
      consent: await this.o.consent.get(),
      models: opts.inspectModels === false ? null : await this.o.models.inspect(),
      download: this.download,
      admission: h3Admission(gpu.tier, this.o.env),
    };
  }

  acceptLicense(sha256: string): Promise<ConsentRecord> {
    return this.o.consent.accept(sha256);
  }

  /** 后台补齐缺的权重;没同意许可就拒绝(一个 HF 请求都不发) */
  async startDownload(): Promise<void> {
    if (!(await this.o.consent.get())) throw new Error('还没有同意 MiniMax H3 许可,不能下载');
    if (this.downloading) return;
    this.downloading = (async () => {
      let file = '';
      try {
        const got = await this.o.models.downloadMissing({
          env: this.o.env,
          log: this.log,
          onFile: (f: ModelFile) => {
            file = `${f.folder}/${f.fileName}`;
            this.download = { state: 'downloading', file, received: 0, total: f.size };
          },
          onProgress: (received, total) => (this.download = { state: 'downloading', file, received, total }),
        });
        this.download = { state: 'done', downloaded: got.map((f) => `${f.folder}/${f.fileName}`) };
      } catch (err) {
        this.download = { state: 'error', message: err instanceof Error ? err.message : String(err) };
      } finally {
        this.downloading = null;
      }
    })();
  }

  /** 等后台下载结束(测试用) */
  async waitDownload(): Promise<void> {
    await this.downloading;
  }

  async generate(input: { prompt: string; seconds: number }): Promise<GenerateResult> {
    if (this.abort) return { ok: false, reason: '已经有一条视频在生成,等它完成后再试。' };
    const abort = new AbortController();
    this.abort = abort;
    try {
      return await this.run(input, abort.signal);
    } catch (err) {
      const message = abort.signal.aborted ? '任务已取消。' : err instanceof Error ? err.message : String(err);
      this.current = abort.signal.aborted ? { state: 'cancelled' } : { state: 'error', message };
      return { ok: false, reason: message };
    } finally {
      this.abort = null;
    }
  }

  private async run(input: { prompt: string; seconds: number }, signal: AbortSignal): Promise<GenerateResult> {
    const fail = (reason: string): GenerateResult => {
      this.current = { state: 'error', message: reason };
      return { ok: false, reason };
    };
    const bad = checkPrompt(input.prompt);
    if (bad) return fail(bad);
    if (!Number.isFinite(input.seconds) || input.seconds <= 0 || input.seconds > MAX_SECONDS) {
      return fail(`时长要在 0–${MAX_SECONDS} 秒之间。`);
    }

    this.current = { state: 'preparing', message: '检查显卡、许可和模型' };
    const st = await this.status();
    if (!st.admission.allowed) return fail(st.admission.reason);
    if (!st.consent) return fail('还没有同意 MiniMax H3 许可:请用户在页面上点「出片」,阅读并勾选同意后下载模型。');
    const missing = (st.models ?? []).filter((m) => m.state !== 'ok');
    if (missing.length) {
      return fail(`MiniMax H3 模型还没下载齐(缺 ${missing.map((m) => m.fileName).join('、')}):请用户在页面上点「出片」下载。`);
    }

    const frames = framesForSeconds(input.seconds);
    const seed = Math.floor(Math.random() * 2 ** 48);
    const clientId = randomUUID();
    const body = buildPromptRequest({ prompt: input.prompt, frames, seed }, clientId);

    this.current = { state: 'preparing', message: '启动 ComfyUI' };
    await this.o.comfy.start();
    signal.throwIfAborted();
    const cs = this.o.comfy.status();
    if (cs.state !== 'running') return fail(`ComfyUI 没能启动:${cs.state === 'error' ? cs.message.split('\n')[0] : cs.state}`);

    const client = new ComfyClient(cs.url);
    const session = await client.connect(clientId, signal);
    const startedAt = new Date();
    this.current = { state: 'running', node: null, value: 0, max: 0, startedAt: startedAt.toISOString() };
    const peaks = { vram: null as number | null, ram: null as number | null, simulated: false };
    const sampler = this.sample(cs.url, peaks, signal);
    const onAbort = () => void client.interrupt();
    signal.addEventListener('abort', onAbort, { once: true });
    let file;
    try {
      ({ file } = await session.run(
        body,
        (p: ComfyProgress) => (this.current = { state: 'running', ...p, startedAt: startedAt.toISOString() }),
        signal,
      ));
    } finally {
      signal.removeEventListener('abort', onAbort);
      sampler.stop();
    }

    const id = `${startedAt.toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${randomUUID().slice(0, 8)}`;
    await mkdir(this.o.library.dir, { recursive: true });
    const dest = this.o.library.fileFor(id);
    try {
      await client.download(file, dest);
      if ((await stat(dest)).size === 0) throw new Error('取回的成片是空文件');
    } catch (err) {
      await rm(dest, { force: true });
      throw err;
    }
    const record: VideoRecord = {
      id,
      model: 'MiniMax H3',
      prompt: input.prompt,
      frames,
      seconds: Math.round((frames / H3_FPS) * 100) / 100,
      seed,
      createdAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt.getTime(),
      peakVramMiB: peaks.vram,
      peakRamMiB: peaks.ram,
      metricsSimulated: peaks.simulated,
      file: dest,
    };
    await this.o.library.add(record);
    this.current = { state: 'done', videoId: id };
    this.log(`[h3] 成片入库 ${id}:${frames} 帧,耗时 ${record.elapsedMs} 毫秒${record.metricsSimulated ? '(假回放,指标为模拟值)' : ''}`);
    const { file: _file, ...pub } = record;
    return { ok: true, video: pub };
  }

  /** 出片期间定时读 ComfyUI 的 /system_stats,记显存与系统内存占用的峰值 */
  private sample(url: string, peaks: { vram: number | null; ram: number | null; simulated: boolean }, signal: AbortSignal) {
    let stopped = false;
    const MiB = 2 ** 20;
    const once = async () => {
      try {
        const s = (await (await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(3_000) })).json()) as {
          system: { ram_total?: number; ram_free?: number; vidroom_fake_replay?: boolean };
          devices: Array<{ vram_total?: number; vram_free?: number }>;
        };
        peaks.simulated ||= s.system.vidroom_fake_replay === true;
        for (const d of s.devices ?? []) {
          if (typeof d.vram_total === 'number' && typeof d.vram_free === 'number' && d.vram_total > 0) {
            peaks.vram = Math.max(peaks.vram ?? 0, Math.round((d.vram_total - d.vram_free) / MiB));
          }
        }
        if (typeof s.system.ram_total === 'number' && typeof s.system.ram_free === 'number') {
          peaks.ram = Math.max(peaks.ram ?? 0, Math.round((s.system.ram_total - s.system.ram_free) / MiB));
        }
      } catch {
        // 采样失败不影响出片
      }
    };
    void (async () => {
      while (!stopped && !signal.aborted) {
        await once();
        await new Promise((r) => setTimeout(r, this.o.sampleMs ?? 1_000));
      }
    })();
    return { stop: () => (stopped = true) };
  }

  /** 取消正在跑的任务:打断 ComfyUI 里的任务,并停掉 ComfyUI(关窗确认后走这里) */
  async cancel(): Promise<void> {
    this.abort?.abort(new Error('已取消'));
    await this.o.comfy.stop();
  }
}
