import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * ComfyUI 出片 API 的最小客户端(接口与消息格式照 ComfyUI v0.38.0 的 server.py / execution.py):
 * - 先连 /ws?clientId=<id>,再 POST /prompt(带同一个 client_id),免得漏掉开头的进度消息;
 * - WebSocket 上的 progress {value,max,node,prompt_id} 转成进度回调;
 *   executing {node:null, prompt_id} 或 execution_success = 跑完;execution_error / execution_interrupted = 失败;
 * - 跑完查 /history/<prompt_id>,找 SaveVideo 的输出(ui 里是 images + animated),用 /view 取文件。
 */

export interface ComfyProgress {
  /** 当前在执行的节点 id */
  node: string | null;
  value: number;
  max: number;
}

export interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

export class ComfyPromptError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
  }
}

export class ComfyClient {
  constructor(readonly baseUrl: string) {}

  /** 连上 WebSocket,返回的 run() 提交工作流并等它跑完 */
  async connect(clientId: string, signal?: AbortSignal): Promise<ComfySession> {
    const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('连不上 ComfyUI 的 WebSocket')), { once: true });
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return new ComfySession(this, ws, clientId);
  }

  async submit(body: unknown): Promise<string> {
    const res = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { prompt_id?: string; error?: { message?: string } } | null;
    if (!res.ok || !json?.prompt_id) {
      throw new ComfyPromptError(`ComfyUI 拒绝了工作流(HTTP ${res.status}):${json?.error?.message ?? '无详情'}`, json);
    }
    return json.prompt_id;
  }

  async history(promptId: string): Promise<{ outputs: Record<string, Record<string, unknown>>; status?: { status_str?: string } } | null> {
    const res = await fetch(`${this.baseUrl}/history/${encodeURIComponent(promptId)}`);
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, { outputs: Record<string, Record<string, unknown>> }>;
    return json[promptId] ?? null;
  }

  async download(file: ComfyOutputFile, dest: string): Promise<void> {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const res = await fetch(`${this.baseUrl}/view?${q}`);
    if (!res.ok || !res.body) throw new Error(`从 ComfyUI 取成片失败:HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
  }

  async interrupt(): Promise<void> {
    await fetch(`${this.baseUrl}/interrupt`, { method: 'POST' }).catch(() => {});
  }
}

export class ComfySession {
  constructor(
    private readonly client: ComfyClient,
    private readonly ws: WebSocket,
    readonly clientId: string,
  ) {}

  /** 提交并等到跑完;返回 SaveVideo 输出的第一个文件 */
  async run(body: unknown, onProgress: (p: ComfyProgress) => void, signal?: AbortSignal): Promise<{ promptId: string; file: ComfyOutputFile }> {
    let promptId: string | null = null;
    const early: Array<{ type: string; data: Record<string, unknown> }> = [];
    let settle: ((err: Error | null) => void) | null = null;
    const done = new Promise<void>((resolve, reject) => {
      settle = (err) => (err ? reject(err) : resolve());
    });
    let node: string | null = null;
    const handle = (msg: { type: string; data: Record<string, unknown> }) => {
      const d = msg.data ?? {};
      if (d.prompt_id !== undefined && d.prompt_id !== promptId) return;
      if (msg.type === 'executing') {
        if (d.node === null) settle?.(null);
        else {
          node = String(d.node);
          onProgress({ node, value: 0, max: 0 });
        }
      } else if (msg.type === 'progress') {
        onProgress({ node: (d.node as string) ?? node, value: Number(d.value), max: Number(d.max) });
      } else if (msg.type === 'execution_success') {
        settle?.(null);
      } else if (msg.type === 'execution_error') {
        settle?.(new ComfyPromptError(`ComfyUI 执行出错:${String(d.exception_message ?? '').slice(0, 500)}`, d));
      } else if (msg.type === 'execution_interrupted') {
        settle?.(new ComfyPromptError('ComfyUI 任务被打断', d));
      }
    };
    this.ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return; // 预览图等二进制帧不管
      let msg: { type: string; data: Record<string, unknown> };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (promptId === null) early.push(msg);
      else handle(msg);
    });
    this.ws.addEventListener('close', () => settle?.(new Error('ComfyUI 的 WebSocket 断开了(ComfyUI 可能已退出)')));
    const onAbort = () => settle?.(signal!.reason instanceof Error ? signal!.reason : new Error('已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      promptId = await this.client.submit(body);
      for (const m of early.splice(0)) handle(m);
      await done;
      // 跑完后 history 可能稍晚才写好
      for (let i = 0; i < 50; i++) {
        const h = await this.client.history(promptId);
        const file = h && findVideo(h.outputs);
        if (file) return { promptId, file };
        if (h?.status?.status_str === 'error') break;
        await sleep(200);
      }
      throw new ComfyPromptError('ComfyUI 跑完了,但 history 里没有找到视频输出');
    } finally {
      signal?.removeEventListener('abort', onAbort);
      settle = null;
      this.ws.close();
    }
  }
}

/** SaveVideo 的 ui 输出:{ images: [{filename, subfolder, type}], animated: [true] } */
export function findVideo(outputs: Record<string, Record<string, unknown>>): ComfyOutputFile | null {
  for (const out of Object.values(outputs ?? {})) {
    const list = (out.images ?? out.videos ?? out.gifs) as ComfyOutputFile[] | undefined;
    const hit = list?.find((f) => typeof f?.filename === 'string' && /\.(mp4|webm|mkv|mov)$/i.test(f.filename));
    if (hit) return { filename: hit.filename, subfolder: hit.subfolder ?? '', type: hit.type ?? 'output' };
  }
  return null;
}
