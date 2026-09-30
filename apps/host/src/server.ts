import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { LanguageModel } from 'ai';
import { LaunchAuth, SESSION_COOKIE, parseCookies, sessionCookieHeader } from './auth.js';
import { runChat, type ChatMessage } from './agent.js';
import type { RunNvidiaSmi } from './gpu.js';

/** 写死只听本机回环地址 */
export const LISTEN_HOST = '127.0.0.1';

export const NO_KEY_MESSAGE = '没有配置 API key,请去设置。';

export interface HostOptions {
  /** 已加载的 LLM 模型;null 表示没配置 key */
  model: LanguageModel | null;
  /** 聊天页构建产物目录(apps/web/dist) */
  webDir: string;
  port?: number;
  runNvidiaSmi?: RunNvidiaSmi;
  /** 需要从错误信息里抹掉的秘密(API key) */
  secrets?: string[];
}

export interface Host {
  server: Server;
  port: number;
  launchUrl: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const MAX_BODY_BYTES = 1_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseMessages(body: unknown): ChatMessage[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const ok = messages.every(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string',
  );
  return ok ? (messages as ChatMessage[]).map(({ role, content }) => ({ role, content })) : null;
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((t, s) => (s ? t.split(s).join('[REDACTED]') : t), text);
}

export async function startHost(opts: HostOptions): Promise<Host> {
  const auth = new LaunchAuth();
  const webRoot = resolve(opts.webDir);
  const secrets = opts.secrets ?? [];

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = resolve(webRoot, rel || 'index.html');
    if (file !== webRoot && !file.startsWith(webRoot + sep)) {
      res.writeHead(404).end();
      return;
    }
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      // 前端单页:未知路径回落到 index.html
      file = join(webRoot, 'index.html');
      try {
        data = await readFile(file);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('聊天页尚未构建(apps/web/dist 不存在)。');
        return;
      }
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const session = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!auth.isValidSession(session)) {
      sendJson(res, 401, { error: 'unauthorized', message: '未登录:请用 Host 启动时打印的启动地址打开页面。' });
      return;
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, { hasApiKey: opts.model !== null });
      return;
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      if (opts.model === null) {
        sendJson(res, 503, { error: 'no_api_key', message: NO_KEY_MESSAGE });
        return;
      }
      let messages: ChatMessage[] | null;
      try {
        messages = parseMessages(await readJson(req));
      } catch {
        messages = null;
      }
      if (messages === null) {
        sendJson(res, 400, { error: 'bad_request', message: '请求格式不对:需要 { messages: [{ role, content }] }。' });
        return;
      }
      try {
        const reply = await runChat(opts.model, messages, opts.runNvidiaSmi);
        sendJson(res, 200, reply);
      } catch (err) {
        console.error('[vidroom] 调用 LLM 失败:', redact(err instanceof Error ? err.message : String(err), secrets));
        sendJson(res, 502, { error: 'llm_error', message: '调用 DeepSeek 失败,请稍后再试或检查 API key。' });
      }
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    const pathname = url.pathname;

    const done = (p: Promise<void>) =>
      p.catch((err) => {
        console.error('[vidroom] 请求处理出错:', redact(err instanceof Error ? err.message : String(err), secrets));
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
        else res.end();
      });

    if (pathname === '/launch') {
      const session = auth.redeem(url.searchParams.get('token'));
      if (session === null) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('启动地址无效或已用过。请重启 VidRoom 获取新的启动地址。');
        return;
      }
      res.writeHead(303, { 'set-cookie': sessionCookieHeader(session), location: '/' });
      res.end();
      return;
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      done(handleApi(req, res, pathname));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    done(serveStatic(pathname, res));
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, LISTEN_HOST, () => ok());
  });
  const { port } = server.address() as AddressInfo;

  return {
    server,
    port,
    launchUrl: `http://${LISTEN_HOST}:${port}/launch?token=${auth.token}`,
    close: () => new Promise((ok, fail) => server.close((e) => (e ? fail(e) : ok()))),
  };
}
