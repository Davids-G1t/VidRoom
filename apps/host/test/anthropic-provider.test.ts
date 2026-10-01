import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ANTHROPIC_MODEL, createModel, runChat } from '../src/agent.js';
import type { MotionService } from '../src/motion/service.js';
import { testTmpDir } from './fixtures/media.js';

/**
 * 验收⑤:选了 Anthropic 之后确实调的是 Anthropic(Messages API),用本机假服务,不发任何真实网络请求。
 * 假服务同时认 Anthropic 的 POST /v1/messages 和 DeepSeek(OpenAI 兼容)的 POST /v1/chat/completions,
 * 记下每个请求的路径、鉴权头和请求体,用来核对「选哪家就走哪家的接口、带哪家的 key」。
 * 没有真 Anthropic key:真服务上的行为未验证。
 */

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

let server: Server;
let base: string;
const seen: Seen[] = [];

const MOTION_INPUT = { title: 'VidRoom', seconds: 10, style: 'gradient' };

function anthropicReply(body: Record<string, unknown>) {
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  const hasToolResult = messages.some((m) => Array.isArray(m.content) && m.content.some((c: { type?: string }) => c.type === 'tool_result'));
  const common = { id: `msg_${seen.length}`, type: 'message', role: 'assistant', model: ANTHROPIC_MODEL, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  const wantsMotion = JSON.stringify(messages[0]?.content ?? '').includes('开场动画');
  if (!wantsMotion) return { ...common, content: [{ type: 'text', text: 'Anthropic 回答' }], stop_reason: 'end_turn' };
  return hasToolResult
    ? { ...common, content: [{ type: 'text', text: '已用代码渲染了一条 10 秒的开场动画。' }], stop_reason: 'end_turn' }
    : { ...common, content: [{ type: 'tool_use', id: 'toolu_1', name: 'render_motion', input: MOTION_INPUT }], stop_reason: 'tool_use' };
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
    seen.push({ path: req.url ?? '', headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v1/messages') res.end(JSON.stringify(anthropicReply(body)));
    else if (req.url === '/v1/chat/completions') {
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', created: 0, model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'DeepSeek 回答' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
});

function fakeMotion(calls: unknown[]): MotionService {
  return {
    render: async (req: unknown) => {
      calls.push(req);
      return { ok: true, video: { id: 'v1', seconds: 10 }, note: '代码渲染(HyperFrames)' };
    },
  } as unknown as MotionService;
}

describe('LLM 提供方选择', () => {
  it('anthropic:走 POST /v1/messages,x-api-key 是填的 key,模型是 claude-opus-5-5,带上 render_motion 工具并执行', async () => {
    const calls: unknown[] = [];
    const reply = await runChat(createModel('anthropic', 'sk-ant-fake-key', base), [{ role: 'user', content: '做一条10秒的开场动画,标题是VidRoom' }], {
      motion: fakeMotion(calls),
    });
    expect(seen.map((s) => s.path)).toEqual(['/v1/messages', '/v1/messages']);
    for (const s of seen) {
      expect(s.headers['x-api-key']).toBe('sk-ant-fake-key');
      expect(s.headers['anthropic-version']).toBeTruthy();
      expect(s.headers.authorization).toBeUndefined();
      expect(s.body.model).toBe(ANTHROPIC_MODEL);
    }
    expect((seen[0].body.tools as Array<{ name: string }>).map((t) => t.name)).toContain('render_motion');
    expect(calls).toEqual([MOTION_INPUT]);
    expect(reply.toolCalls.map((c) => c.toolName)).toEqual(['render_motion']);
    expect(reply.text).toContain('开场动画');
  });

  it('deepseek:同一个假服务上走的是 /v1/chat/completions,Bearer 头,不碰 /v1/messages', async () => {
    const reply = await runChat(createModel('deepseek', 'sk-deepseek-fake', base), [{ role: 'user', content: '你好' }]);
    expect(seen.map((s) => s.path)).toEqual(['/v1/chat/completions']);
    expect(seen[0].headers.authorization).toBe('Bearer sk-deepseek-fake');
    expect(seen[0].headers['x-api-key']).toBeUndefined();
    expect(reply.text).toBe('DeepSeek 回答');
  });
});

describe('命令行起 Host:VIDROOM_LLM_PROVIDER=anthropic 时聊天请求到 Anthropic 假服务', () => {
  let child: ChildProcess | undefined;
  let dir: string;

  afterAll(() => {
    child?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('main.ts 按环境变量选 Anthropic、读它的 key 文件、调它的接口', async () => {
    dir = testTmpDir('anthropic-host-');
    const keyFile = join(dir, 'anthropic-key');
    writeFileSync(keyFile, 'sk-ant-from-file\n');
    const env: NodeJS.ProcessEnv = { ...process.env, VIDROOM_DATA_DIR: join(dir, 'data'), VIDROOM_LLM_PROVIDER: 'anthropic', VIDROOM_ANTHROPIC_KEY_FILE: keyFile, VIDROOM_ANTHROPIC_BASE_URL: base };
    delete env.VIDROOM_DEEPSEEK_KEY_FILE;
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (out += d));
    const launchUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Host 60 秒内没打印启动地址:\n${out}`)), 60_000);
      child!.stdout!.on('data', () => {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/launch\?token=[0-9a-f]+)/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
    });
    const res = await fetch(launchUrl, { redirect: 'manual' });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    const origin = new URL(launchUrl).origin;
    expect((await (await fetch(`${origin}/api/status`, { headers: { cookie } })).json()) as { hasApiKey: boolean }).toMatchObject({ hasApiKey: true });

    // 这里只核对请求去了哪、带了什么 key(不触发渲染)—— 真渲染在 e2e 里测
    const chat = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '随便聊一句' }] }),
    });
    expect(chat.status).toBe(200);
    expect(((await chat.json()) as { text: string }).text).toBe('Anthropic 回答');
    expect(seen.map((s) => s.path)).toEqual(['/v1/messages']);
    expect(seen[0].headers['x-api-key']).toBe('sk-ant-from-file');
    expect(out).not.toContain('sk-ant-from-file');
  }, 120_000);
});
