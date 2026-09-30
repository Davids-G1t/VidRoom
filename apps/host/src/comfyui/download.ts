import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * 断点续传下载 + sha256 校验。
 * - 先写到 `<dest>.part`;每次请求前看它已有多少字节,有就发 `Range: bytes=<已有>-` 从那里接着下。
 *   网络中途断开 → 等一下自动重试并续传;进程退出后再调一次也会从 .part 接着下。
 * - 服务器不认 Range(回 200 而不是 206)→ 只能从头下,.part 清空重写。
 * - 下满清单里的字节数后算 sha256;对不上删掉重下一遍,仍不对就报错。通过才改名成 dest。
 */

export interface DownloadOptions {
  url: string;
  dest: string;
  size: number;
  sha256: string;
  /** 网络出错后最多重试几次(每次都续传) */
  retries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
  log?: (msg: string) => void;
}

export interface DownloadResult {
  /** 每次续传请求的起始字节(没续传过就是空数组) */
  resumedFrom: number[];
  /** sha256 对不上而整个重下的次数 */
  redownloads: number;
}

export class ChecksumMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`sha256 不一致:应为 ${expected},实际 ${actual}`);
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** 已有 dest 且校验通过就直接用;否则下载。 */
export async function downloadVerified(opts: DownloadOptions): Promise<DownloadResult> {
  const log = opts.log ?? (() => {});
  const result: DownloadResult = { resumedFrom: [], redownloads: 0 };

  if ((await fileSize(opts.dest)) === opts.size && (await sha256File(opts.dest)) === opts.sha256) {
    log(`[comfyui] ${opts.dest} 已存在且 sha256 一致,不重下`);
    return result;
  }
  await rm(opts.dest, { force: true });

  const part = `${opts.dest}.part`;
  for (let round = 0; ; round++) {
    await fetchToPart(opts, part, result, log);
    const actual = await sha256File(part);
    if (actual === opts.sha256) break;
    await rm(part, { force: true });
    if (round >= 1) throw new ChecksumMismatchError(opts.sha256, actual);
    log(`[comfyui] sha256 不一致(${actual}),删掉重下`);
    result.redownloads += 1;
  }
  await rename(part, opts.dest);
  return result;
}

async function fetchToPart(opts: DownloadOptions, part: string, result: DownloadResult, log: (m: string) => void) {
  const retries = opts.retries ?? 5;
  const delay = opts.retryDelayMs ?? 2_000;
  for (let attempt = 0; ; attempt++) {
    let offset = await fileSize(part);
    if (offset > opts.size) {
      await rm(part, { force: true });
      offset = 0;
    }
    if (offset === opts.size) return;
    try {
      await fetchOnce(opts, part, offset, result, log);
      if ((await fileSize(part)) === opts.size) return;
      throw new Error(`下载提前结束:${await fileSize(part)} / ${opts.size} 字节`);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (attempt >= retries) throw err;
      log(`[comfyui] 下载中断(${err instanceof Error ? err.message : String(err)}),${delay} 毫秒后续传`);
      await sleep(delay);
    }
  }
}

async function fetchOnce(
  opts: DownloadOptions,
  part: string,
  offset: number,
  result: DownloadResult,
  log: (m: string) => void,
): Promise<void> {
  const headers: Record<string, string> = offset > 0 ? { range: `bytes=${offset}-` } : {};
  const res = await fetch(opts.url, { headers, signal: opts.signal, redirect: 'follow' });

  let append = false;
  if (offset > 0 && res.status === 206) {
    const start = Number(/^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')?.[1]);
    if (start !== offset) {
      await res.body?.cancel();
      await rm(part, { force: true });
      throw new Error(`服务器续传位置不对:要 ${offset},给的是 ${res.headers.get('content-range')}`);
    }
    append = true;
    result.resumedFrom.push(offset);
    log(`[comfyui] 从第 ${offset} 字节续传`);
  } else if (res.status === 200) {
    if (offset > 0) log('[comfyui] 服务器不支持续传,从头下载');
  } else if (res.status === 416 && offset > 0) {
    await res.body?.cancel();
    await rm(part, { force: true });
    throw new Error('服务器拒绝续传范围(416),清空后重下');
  } else {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.body) throw new Error('响应没有正文');

  let received = append ? offset : 0;
  const progress = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      opts.onProgress?.(received, opts.size);
      cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    progress,
    createWriteStream(part, { flags: append ? 'a' : 'w' }),
  );
}
