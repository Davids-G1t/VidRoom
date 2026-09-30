import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChecksumMismatchError, downloadVerified } from '../src/comfyui/download.js';
import { COMFYUI_PORTABLE, DOWNLOAD_URL_ENV, portableDownloadUrl } from '../src/comfyui/manifest.js';

const DATA = randomBytes(3 * 1024 * 1024 + 123);
const SHA = createHash('sha256').update(DATA).digest('hex');

interface FakeServer {
  url: string;
  /** 每个请求的 Range 头(没有就是 null) */
  ranges: Array<string | null>;
  close: () => Promise<void>;
}

/**
 * 本机假下载服务器:
 * - dropAfter:前 n 个请求只发这么多字节就把连接掐断(模拟网络中途断开);
 * - ignoreRange:不认 Range,一律 200 从头发;
 * - corruptTimes:前 n 次完整下载发的是坏数据。
 */
async function fakeServer(opts: { dropAfter?: number; drops?: number; ignoreRange?: boolean; corruptTimes?: number } = {}): Promise<FakeServer> {
  const ranges: Array<string | null> = [];
  let drops = opts.drops ?? 0;
  let corrupt = opts.corruptTimes ?? 0;
  const server: Server = createServer((req: IncomingMessage, res) => {
    ranges.push(req.headers.range ?? null);
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = m && !opts.ignoreRange ? Number(m[1]) : 0;
    let body = DATA.subarray(start);
    if (start === 0 && corrupt > 0) {
      corrupt -= 1;
      body = Buffer.from(body);
      body[body.length - 1] ^= 0xff;
    }
    const headers: Record<string, string | number> = { 'content-length': body.length, 'accept-ranges': 'bytes' };
    if (start > 0) {
      if (start >= DATA.length) {
        res.writeHead(416, { 'content-range': `bytes */${DATA.length}` }).end();
        return;
      }
      headers['content-range'] = `bytes ${start}-${DATA.length - 1}/${DATA.length}`;
    }
    res.writeHead(start > 0 ? 206 : 200, headers);
    if (drops > 0 && opts.dropAfter !== undefined) {
      drops -= 1;
      res.write(body.subarray(0, opts.dropAfter), () => res.socket?.destroy());
      return;
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ComfyUI_windows_portable_nvidia.7z`,
    ranges,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

let srv: FakeServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

const tmp = () => join(mkdtempSync(join(tmpdir(), 'vidroom-dl-')), 'portable.7z');

describe('downloadVerified', () => {
  it('一次下完,sha256 一致', async () => {
    srv = await fakeServer();
    const dest = tmp();
    const r = await downloadVerified({ url: srv.url, dest, size: DATA.length, sha256: SHA });
    expect(r.resumedFrom).toEqual([]);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('中途断开两次:用 Range 从已下载的字节续传,不重头下,最后 sha256 一致', async () => {
    const chunk = 1024 * 1024;
    srv = await fakeServer({ dropAfter: chunk, drops: 2 });
    const dest = tmp();
    const r = await downloadVerified({ url: srv.url, dest, size: DATA.length, sha256: SHA, retryDelayMs: 10 });
    // 断开时已经到手、写进 .part 的字节数取决于管道缓冲,不一定正好是 chunk;要的是「接着下」,不是从 0 重来
    expect(r.resumedFrom).toHaveLength(2);
    expect(r.resumedFrom[0]).toBeGreaterThan(0);
    expect(r.resumedFrom[1]).toBeGreaterThan(r.resumedFrom[0]);
    expect(r.resumedFrom[1]).toBeLessThanOrEqual(2 * chunk);
    expect(srv.ranges).toEqual([null, `bytes=${r.resumedFrom[0]}-`, `bytes=${r.resumedFrom[1]}-`]);
    expect(createHash('sha256').update(readFileSync(dest)).digest('hex')).toBe(SHA);
  });

  it('上次进程退出留下的 .part:再调一次从它的大小接着下', async () => {
    srv = await fakeServer();
    const dest = tmp();
    writeFileSync(`${dest}.part`, DATA.subarray(0, 777_777));
    const r = await downloadVerified({ url: srv.url, dest, size: DATA.length, sha256: SHA });
    expect(r.resumedFrom).toEqual([777_777]);
    expect(srv.ranges).toEqual(['bytes=777777-']);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it('服务器不认 Range(回 200):从头重下,不会把整份内容接在旧数据后面', async () => {
    srv = await fakeServer({ ignoreRange: true });
    const dest = tmp();
    writeFileSync(`${dest}.part`, DATA.subarray(0, 1000));
    const r = await downloadVerified({ url: srv.url, dest, size: DATA.length, sha256: SHA });
    expect(r.resumedFrom).toEqual([]);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it('sha256 对不上:删掉重下一遍', async () => {
    srv = await fakeServer({ corruptTimes: 1 });
    const dest = tmp();
    const r = await downloadVerified({ url: srv.url, dest, size: DATA.length, sha256: SHA });
    expect(r.redownloads).toBe(1);
    expect(readFileSync(dest).equals(DATA)).toBe(true);
  });

  it('重下仍对不上:报错,不留下文件', async () => {
    srv = await fakeServer({ corruptTimes: 99 });
    const dest = tmp();
    await expect(downloadVerified({ url: srv.url, dest, size: DATA.length, sha256: SHA })).rejects.toBeInstanceOf(
      ChecksumMismatchError,
    );
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('目标文件已在且校验通过:不发请求', async () => {
    srv = await fakeServer();
    const dest = tmp();
    writeFileSync(dest, DATA);
    await downloadVerified({ url: srv.url, dest, size: DATA.length, sha256: SHA });
    expect(srv.ranges).toEqual([]);
  });
});

describe('清单与镜像', () => {
  it('默认用官方 Release 地址;设了环境变量就换成镜像地址', () => {
    expect(portableDownloadUrl({})).toBe(
      'https://github.com/Comfy-Org/ComfyUI/releases/download/v0.38.0/ComfyUI_windows_portable_nvidia.7z',
    );
    expect(portableDownloadUrl({ [DOWNLOAD_URL_ENV]: 'https://mirror.example/comfy.7z' })).toBe('https://mirror.example/comfy.7z');
    expect(COMFYUI_PORTABLE.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
