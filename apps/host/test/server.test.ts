import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth.js';
import { NO_KEY_MESSAGE, startHost, type Host, type HostOptions } from '../src/server.js';

const webDir = mkdtempSync(join(tmpdir(), 'vidroom-web-'));
writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>VidRoom</title>');

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** 第一步调 probe_gpu,第二步把工具结果写进回答 */
function toolCallingModel() {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      step += 1;
      if (step === 1) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'probe_gpu', input: '{}' }],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
          warnings: [],
        };
      }
      const toolMsg = options.prompt.find((m) => m.role === 'tool');
      const part = toolMsg?.content[0];
      const output = part && part.type === 'tool-result' ? JSON.stringify(part.output) : '';
      return {
        content: [{ type: 'text', text: `工具结果:${output}` }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

let host: Host | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

async function start(opts: Partial<HostOptions> = {}): Promise<Host> {
  host = await startHost({ model: null, webDir, ...opts });
  return host;
}

async function login(h: Host): Promise<string> {
  const res = await fetch(h.launchUrl, { redirect: 'manual' });
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe('/');
  const setCookie = res.headers.get('set-cookie') ?? '';
  expect(setCookie).toMatch(/HttpOnly/);
  const m = setCookie.match(new RegExp(`${SESSION_COOKIE}=([0-9a-f]+)`));
  expect(m).not.toBeNull();
  return `${SESSION_COOKIE}=${m![1]}`;
}

const base = (h: Host) => `http://127.0.0.1:${h.port}`;

describe('监听地址', () => {
  it('只听 127.0.0.1', async () => {
    const h = await start();
    const addr = h.server.address();
    expect(addr).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(h.launchUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/launch\?token=[0-9a-f]{64}$/);
  });
});

describe('启动地址换 Cookie', () => {
  it('不带 cookie 的 API 请求 → 401', async () => {
    const h = await start();
    expect((await fetch(`${base(h)}/api/status`)).status).toBe(401);
    expect((await fetch(`${base(h)}/api/chat`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('cookie 不对 → 401', async () => {
    const h = await start();
    const res = await fetch(`${base(h)}/api/status`, { headers: { cookie: `${SESSION_COOKIE}=deadbeef` } });
    expect(res.status).toBe(401);
  });

  it('错误 token → 403,不发 cookie', async () => {
    const h = await start();
    const res = await fetch(`${base(h)}/launch?token=${'0'.repeat(64)}`, { redirect: 'manual' });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('正确 token 兑换一次后 cookie 生效;同一 token 第二次 → 403', async () => {
    const h = await start();
    const cookie = await login(h);
    const status = await fetch(`${base(h)}/api/status`, { headers: { cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ hasApiKey: false });

    const again = await fetch(h.launchUrl, { redirect: 'manual' });
    expect(again.status).toBe(403);
    expect(again.headers.get('set-cookie')).toBeNull();
  });

  it('静态页面不需要 cookie', async () => {
    const h = await start();
    const res = await fetch(`${base(h)}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('VidRoom');
  });
});

describe('聊天接口', () => {
  it('没有 key:明确告知去设置,不崩', async () => {
    const h = await start({ model: null });
    const cookie = await login(h);
    const res = await fetch(`${base(h)}/api/chat`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no_api_key', message: NO_KEY_MESSAGE });
  });

  it('agent 调 probe_gpu 工具,响应里带工具调用记录与探测数字', async () => {
    const smi16 = readFileSync(new URL('./fixtures/nvidia-smi-16gb-rtx4060ti.txt', import.meta.url), 'utf8');
    const h = await start({ model: toolCallingModel(), runNvidiaSmi: async () => smi16 });
    const cookie = await login(h);
    const res = await fetch(`${base(h)}/api/chat`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '我这台电脑能跑什么' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.toolCalls).toHaveLength(1);
    expect(body.toolCalls[0]).toMatchObject({
      toolName: 'probe_gpu',
      output: { tier: 'experimental', primary: { name: 'NVIDIA GeForce RTX 4060 Ti', memoryMiB: 16380, memoryGiB: 16 } },
    });
    expect(body.text).toContain('RTX 4060 Ti');
  });

  it('请求格式不对 → 400', async () => {
    const h = await start({ model: toolCallingModel() });
    const cookie = await login(h);
    const res = await fetch(`${base(h)}/api/chat`, { method: 'POST', headers: { cookie }, body: 'not json' });
    expect(res.status).toBe(400);
  });

  it('LLM 出错时 key 不出现在响应和日志里', async () => {
    const secret = 'FAKE_KEY_should_never_leak_42';
    const failing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error(`upstream rejected key ${secret}`);
      },
    });
    const h = await start({ model: failing, secrets: [secret] });
    const cookie = await login(h);
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      const res = await fetch(`${base(h)}/api/chat`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain(secret);
    } finally {
      console.error = origError;
    }
    expect(errors.join('\n')).not.toContain(secret);
    expect(errors.join('\n')).toContain('[REDACTED]');
  });
});
