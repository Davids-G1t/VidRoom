import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CONTENT_SECURITY_POLICY, handleAppRequest, type ForwardApi } from '../src/app-protocol.js';

const webDir = mkdtempSync(join(tmpdir(), 'vidroom-desktop-web-'));
writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>VidRoom</title>');
mkdirSync(join(webDir, 'assets'));
writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
writeFileSync(join(webDir, '..', 'outside-secret.txt'), 'outside');

const noApi: ForwardApi = async () => {
  throw new Error('不该转发');
};

const get = (url: string, forwardApi: ForwardApi = noApi) => handleAppRequest(new Request(url), { webDir, forwardApi });

describe('静态文件', () => {
  it('首页带 CSP;js 的 MIME 正确', async () => {
    const res = await get('vidroom-app://app/index.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    const js = await get('vidroom-app://app/assets/app.js');
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(await js.text()).toBe('console.log(1)');
  });

  it('未知路径回落到 index.html;逃出目录的路径拿不到外面的文件', async () => {
    expect(await (await get('vidroom-app://app/some/route')).text()).toContain('<title>VidRoom</title>');
    for (const p of ['/../outside-secret.txt', '/%2e%2e/outside-secret.txt', '/..%5coutside-secret.txt']) {
      const text = await (await get(`vidroom-app://app${p}`)).text();
      expect(text).not.toContain('outside');
    }
  });

  it('别的主机名 → 404', async () => {
    expect((await get('vidroom-app://evil/index.html')).status).toBe(404);
  });
});

describe('/api 转发', () => {
  it('原样转发方法、路径、正文和 content-type;只回状态码、正文和 content-type', async () => {
    const forwardApi = vi.fn<ForwardApi>(async () =>
      new Response('{"text":"hi"}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'vidroom_session=abc', 'x-other': '1' },
      }),
    );
    const req = new Request('vidroom-app://app/api/chat?x=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"messages":[]}',
    });
    const res = await handleAppRequest(req, { webDir, forwardApi });
    expect(forwardApi).toHaveBeenCalledTimes(1);
    const [path, init] = forwardApi.mock.calls[0];
    expect(path).toBe('/api/chat?x=1');
    expect(init.method).toBe('POST');
    expect(init.contentType).toBe('application/json');
    expect(Buffer.from(init.body!).toString()).toBe('{"messages":[]}');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"text":"hi"}');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-other')).toBeNull();
  });

  it('GET 不带正文;状态码照传', async () => {
    const forwardApi = vi.fn<ForwardApi>(async () => new Response('{}', { status: 503 }));
    const res = await get('vidroom-app://app/api/status', forwardApi);
    expect(forwardApi.mock.calls[0][1].body).toBeUndefined();
    expect(res.status).toBe(503);
  });
});
