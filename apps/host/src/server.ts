import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { LanguageModel } from 'ai';
import { LaunchAuth, SESSION_COOKIE, parseCookies, sessionCookieHeader } from './auth.js';
import { runChat, type ChatMessage } from './agent.js';
import type { RunNvidiaSmi } from './gpu.js';
import type { ComfyManager } from './comfyui/manager.js';
import type { VideoService } from './h3/service.js';

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
  /** ComfyUI 生命周期;不给就没有 /api/comfyui 接口(单测用) */
  comfy?: ComfyManager;
  /** 出片服务;不给就没有 generate_video 工具和 /api/h3、/api/videos 接口 */
  video?: VideoService;
}

export interface Host {
  server: Server;
  port: number;
  launchUrl: string;
  /** 换模型(桌面壳在设置页存了新 key 时调用);需要抹掉的秘密一并换掉 */
  setModel(model: LanguageModel | null, secrets: string[]): void;
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
  let model = opts.model;
  let secrets = opts.secrets ?? [];

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

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const session = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!auth.isValidSession(session)) {
      sendJson(res, 401, { error: 'unauthorized', message: '未登录:请用 Host 启动时打印的启动地址打开页面。' });
      return;
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, { hasApiKey: model !== null });
      return;
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      if (model === null) {
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
        const reply = await runChat(model, messages, { runNvidiaSmi: opts.runNvidiaSmi, video: opts.video });
        sendJson(res, 200, reply);
      } catch (err) {
        console.error('[vidroom] 调用 LLM 失败:', redact(err instanceof Error ? err.message : String(err), secrets));
        sendJson(res, 502, { error: 'llm_error', message: '调用 DeepSeek 失败,请稍后再试或检查 API key。' });
      }
      return;
    }

    if (opts.comfy && pathname === '/api/comfyui' && req.method === 'GET') {
      sendJson(res, 200, opts.comfy.status());
      return;
    }
    if (opts.comfy && pathname === '/api/comfyui/start' && req.method === 'POST') {
      void opts.comfy.start();
      sendJson(res, 202, opts.comfy.status());
      return;
    }
    if (opts.comfy && pathname === '/api/comfyui/stop' && req.method === 'POST') {
      await opts.comfy.stop();
      sendJson(res, 200, opts.comfy.status());
      return;
    }

    if (opts.video && (await handleVideoApi(opts.video, req, res, pathname, url))) return;

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
      done(handleApi(req, res, pathname, url));
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
    setModel: (m, s) => {
      model = m;
      secrets = s;
    },
    close: async () => {
      await opts.comfy?.stop();
      await new Promise<void>((ok, fail) => server.close((e) => (e ? fail(e) : ok())));
    },
  };
}

/** 出片相关接口;处理了返回 true */
async function handleVideoApi(video: VideoService, req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
  const method = req.method;
  if (pathname === '/api/h3' && method === 'GET') {
    // 核对模型要算 sha256(首次几十 GB 要一分钟上下,之后走缓存),只在明确要时才做
    sendJson(res, 200, await video.status({ inspectModels: url.searchParams.get('models') === '1' }));
    return true;
  }
  if (pathname === '/api/h3/consent' && method === 'POST') {
    let sha = '';
    try {
      sha = String(((await readJson(req)) as { licenseSha256?: unknown })?.licenseSha256 ?? '');
    } catch {
      // 当成空
    }
    try {
      sendJson(res, 200, await video.acceptLicense(sha));
    } catch (err) {
      sendJson(res, 409, { error: 'license_mismatch', message: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  if (pathname === '/api/h3/download' && method === 'POST') {
    try {
      await video.startDownload();
      sendJson(res, 202, (await video.status({ inspectModels: false })).download);
    } catch (err) {
      sendJson(res, 403, { error: 'no_consent', message: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  if (pathname === '/api/video/job' && method === 'GET') {
    sendJson(res, 200, video.job());
    return true;
  }
  if (pathname === '/api/video/cancel' && method === 'POST') {
    await video.cancel();
    sendJson(res, 200, video.job());
    return true;
  }
  if (pathname === '/api/videos' && method === 'GET') {
    sendJson(res, 200, (await video.library().list()).map(({ file: _f, ...pub }) => pub));
    return true;
  }
  const m = /^\/api\/videos\/([\w-]+)\/file$/.exec(pathname);
  if (m && method === 'GET') {
    const rec = await video.library().get(m[1]);
    const size = rec ? await stat(rec.file).then((s) => s.size, () => null) : null;
    if (!rec || size === null) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'cache-control': 'no-store' });
    await pipeline(createReadStream(rec.file), res);
    return true;
  }
  return false;
}
