/**
 * ComfyUI 的 HTTP 客户端:排队、查历史、取产物。只用四个端点
 * (/prompt、/history、/view、/system_stats),不需要 WebSocket —— 插件是
 * 一次性提交 + 轮询,进度条交给 ComfyUI 自己。
 */
import type { ApiPrompt } from './h3.js';

/** ComfyUI 报出来的一个产物文件。 */
export interface MediaRef {
  filename: string;
  subfolder: string;
  type: string;
  format?: string;
}

/** /history/<id> 里一个节点产出的媒体。 */
export interface HistoryOutput {
  videos?: MediaRef[];
  gifs?: MediaRef[];
  images?: MediaRef[];
  audio?: MediaRef[];
}

/** /history/<id> 的条目。 */
export interface HistoryEntry {
  outputs: Record<string, HistoryOutput>;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: unknown[];
  };
}

export interface SystemStats {
  /** 显卡总显存(GiB)。没有 N 卡时 undefined。 */
  vramTotalGiB?: number;
  /** 当前空闲显存(GiB)。 */
  vramFreeGiB?: number;
}

/** 一次生成的最终结果。 */
export interface CompletedRun {
  promptId: string;
  status: 'success' | 'error';
  /** 产物文件(视频/图片/音频)。 */
  media: MediaRef[];
  /** 失败时的原因(ComfyUI 的 execution_error 原文)。 */
  error?: string;
  elapsedMs: number;
}

export class ComfyUIError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ComfyUIError';
  }
}

/** 每次运行固定的客户端 id:ComfyUI 用它把 WebSocket 事件与队列项对上。 */
export const CLIENT_ID = `dsh-vidroom-${Math.random().toString(36).slice(2, 10)}`;

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: unknown; node_errors?: unknown };
    const detail = parsed.error === undefined ? text : JSON.stringify(parsed.error);
    const nodes = parsed.node_errors === undefined ? '' : ` node_errors=${JSON.stringify(parsed.node_errors)}`;
    return `${detail}${nodes}`.slice(0, 800);
  } catch {
    return text.slice(0, 800);
  }
}

export class ComfyUIClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly pollIntervalMs: number,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  /** 提交一次生成,返回 ComfyUI 的 prompt_id。 */
  async queue(prompt: ApiPrompt, extraPngInfo: Record<string, unknown> = {}): Promise<string> {
    const response = await fetch(this.url('/prompt'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        client_id: CLIENT_ID,
        extra_data: { extra_pnginfo: extraPngInfo },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new ComfyUIError(
        `ComfyUI 拒绝了这次提交(${response.status}):${await readError(response)}`,
        response.status,
      );
    }
    const body = (await response.json()) as { prompt_id?: string; error?: unknown; node_errors?: unknown };
    if (typeof body.prompt_id !== 'string') {
      throw new ComfyUIError(`ComfyUI 没有返回 prompt_id:${JSON.stringify(body).slice(0, 400)}`);
    }
    return body.prompt_id;
  }

  /** 读一次历史;任务还没进历史时返回 undefined。 */
  async history(promptId: string): Promise<HistoryEntry | undefined> {
    const response = await fetch(this.url(`/history/${encodeURIComponent(promptId)}`), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new ComfyUIError(`读 /history 失败(${response.status}):${await readError(response)}`, response.status);
    }
    const body = (await response.json()) as Record<string, HistoryEntry>;
    return body[promptId];
  }

  /** 等到任务完成(成功或失败);超时抛错。 */
  async waitForCompletion(promptId: string, signal?: AbortSignal): Promise<CompletedRun> {
    const startedAt = Date.now();
    for (;;) {
      if (signal?.aborted === true) throw new ComfyUIError('已取消等待');
      const entry = await this.history(promptId);
      if (entry !== undefined) {
        const statusStr = entry.status?.status_str;
        const failed =
          statusStr === 'error' ||
          (statusStr === undefined && entry.status?.completed === false && this.hasExecutionError(entry));
        const media = collectMedia(entry);
        if (failed) {
          return {
            promptId,
            status: 'error',
            media,
            error: executionError(entry) ?? 'ComfyUI 报错但没有给出原因',
            elapsedMs: Date.now() - startedAt,
          };
        }
        if (media.length > 0 || entry.status?.completed === true || statusStr === 'success') {
          return { promptId, status: 'success', media, elapsedMs: Date.now() - startedAt };
        }
      }
      if (Date.now() - startedAt > this.timeoutMs) {
        throw new ComfyUIError(`等了 ${Math.round(this.timeoutMs / 1000)} 秒还没出结果(prompt_id=${promptId})`);
      }
      await sleep(this.pollIntervalMs, signal);
    }
  }

  private hasExecutionError(entry: HistoryEntry): boolean {
    return executionError(entry) !== undefined;
  }

  /** /system_stats 里的显存状态,用来判断本机能不能跑 H3。 */
  async systemStats(): Promise<SystemStats> {
    const response = await fetch(this.url('/system_stats'), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new ComfyUIError(`读 /system_stats 失败(${response.status}):${await readError(response)}`, response.status);
    }
    const body = (await response.json()) as {
      devices?: Array<{ vram_total?: number; vram_free?: number }>;
    };
    const device = body.devices?.[0];
    if (device === undefined) return {};
    const toGiB = (bytes: number | undefined): number | undefined =>
      typeof bytes === 'number' ? bytes / 1024 ** 3 : undefined;
    return { vramTotalGiB: toGiB(device.vram_total), vramFreeGiB: toGiB(device.vram_free) };
  }

  /** 让 ComfyUI 中断当前任务。 */
  async interrupt(): Promise<void> {
    await fetch(this.url('/interrupt'), { method: 'POST', signal: AbortSignal.timeout(10_000) });
  }

  /** 一个产物文件在 ComfyUI 上的播放地址(浏览器可直接 <video src=...>)。 */
  viewUrl(ref: MediaRef): string {
    const query = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
    return this.url(`/view?${query.toString()}`);
  }

  /** 下载产物文件。 */
  async download(ref: MediaRef): Promise<Buffer> {
    const response = await fetch(this.viewUrl(ref), { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new ComfyUIError(`下载产物失败(${response.status}):${await readError(response)}`, response.status);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

/** 按扩展名判产物种类(面板据此挑播放器)。 */
export function mediaKind(filename: string): 'video' | 'image' | 'audio' | 'other' {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) return 'video';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) return 'audio';
  return 'other';
}

/** 把一个历史条目的 outputs 摊成媒体列表(顺序:视频、动画、图片、音频)。 */
export function collectMedia(entry: HistoryEntry): MediaRef[] {
  const media: MediaRef[] = [];
  for (const output of Object.values(entry.outputs ?? {})) {
    for (const key of ['videos', 'gifs', 'images', 'audio'] as const) {
      for (const ref of output[key] ?? []) media.push(ref);
    }
  }
  return media;
}

/** 从历史条目里抠出 ComfyUI 的报错原文。 */
export function executionError(entry: HistoryEntry): string | undefined {
  const messages = entry.status?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== 'execution_error') continue;
    const payload = message[1] as { exception_message?: string; node_type?: string; node_id?: string } | undefined;
    if (payload === undefined) continue;
    const where = payload.node_type === undefined ? '' : `${payload.node_type}#${payload.node_id ?? '?'}: `;
    return `${where}${payload.exception_message ?? 'execution_error'}`;
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ComfyUIError('已取消等待'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
