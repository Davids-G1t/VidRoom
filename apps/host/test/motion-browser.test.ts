import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROWSER_BUILDS, BROWSER_DOWNLOAD_URL_ENV, HEADLESS_SHELL_VERSION, browserLayout, ensureBrowser, type BrowserBuild } from '../src/motion/browser.js';
import { testTmpDir } from './fixtures/media.js';
import { makeZip } from './fixtures/zip.js';

/**
 * chrome-headless-shell 的首次下载:清单锁版本 + sha256,下载 → 校验 → 解压 → 写标记;再调一次直接用,不再下。
 * 用本机假服务发一个几百字节的假压缩包(不真去下 100 多 MB);真包在 e2e(motion 项目)里下。
 */

let server: Server;
let base: string;
const requests: string[] = [];
const exe = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
const zip = makeZip([
  { name: 'fake-shell/', data: Buffer.alloc(0) },
  { name: `fake-shell/${exe}`, data: Buffer.from('#!/bin/sh\necho fake\n'), executable: true },
  { name: 'fake-shell/LICENSE.headless_shell', data: Buffer.from('BSD-3-Clause (fake)') },
]);
const build: BrowserBuild = {
  version: 'test-1',
  fileName: 'fake-shell.zip',
  url: 'https://example.invalid/should-not-be-used.zip',
  size: zip.length,
  sha256: createHash('sha256').update(zip).digest('hex'),
  rootDir: 'fake-shell',
  exe,
};
const dirs: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/fake-shell.zip') res.writeHead(200, { 'content-length': zip.length }).end(zip);
    else if (req.url === '/corrupt.zip') res.writeHead(200, { 'content-length': zip.length }).end(Buffer.alloc(zip.length, 1));
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('浏览器清单', () => {
  it('Windows 与 Linux 各锁一份,来自 Chrome for Testing 公开存储桶,sha256 是 64 位十六进制', () => {
    for (const p of ['win32', 'linux'] as const) {
      const b = BROWSER_BUILDS[p]!;
      expect(b.version).toBe(HEADLESS_SHELL_VERSION);
      expect(b.url).toBe(`https://storage.googleapis.com/chrome-for-testing-public/${HEADLESS_SHELL_VERSION}/${p === 'win32' ? 'win64' : 'linux64'}/${b.fileName}`);
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(b.size).toBeGreaterThan(100_000_000);
    }
  });
});

describe('ensureBrowser', () => {
  it('第一次:下载、校验、解压、写标记,删掉压缩包;第二次直接用,不再请求', async () => {
    const root = testTmpDir('browser-');
    dirs.push(root);
    const env = { [BROWSER_DOWNLOAD_URL_ENV]: `${base}/fake-shell.zip` };
    const path = await ensureBrowser({ root, env, build });
    const layout = browserLayout(root, build);
    expect(path).toBe(layout.exe);
    expect(readFileSync(path, 'utf8')).toContain('echo fake');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(JSON.parse(readFileSync(layout.marker, 'utf8'))).toEqual({ version: 'test-1', sha256: build.sha256 });
    expect(existsSync(layout.archive)).toBe(false);
    expect(requests.filter((u) => u === '/fake-shell.zip')).toHaveLength(1);

    // 再调一次:不再请求
    const again = await ensureBrowser({ root, env, build });
    expect(again).toBe(path);
    expect(requests.filter((u) => u === '/fake-shell.zip')).toHaveLength(1);
  });

  it('sha256 对不上:报错,不留安装目录', async () => {
    const root = testTmpDir('browser-bad-');
    dirs.push(root);
    const env = { [BROWSER_DOWNLOAD_URL_ENV]: `${base}/corrupt.zip` };
    await expect(ensureBrowser({ root, env, build })).rejects.toThrow(/sha256/);
    expect(existsSync(browserLayout(root, build).installDir)).toBe(false);
  });
});
