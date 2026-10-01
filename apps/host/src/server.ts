import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { LanguageModel } from 'ai';
import { LaunchAuth, SESSION_COOKIE, parseCookies, sessionCookieHeader } from './auth.js';
import { runChat, type ChatMessage } from './agent.js';
import type { CloudService } from './cloud/service.js';
import type { VideoEditor } from './ffmpeg/editor.js';
import { probeGpu, withForcedTier, type RunNvidiaSmi } from './gpu.js';
import type { SettingsStore } from './settings.js';
import type { ComfyManager } from './comfyui/manager.js';
import { publicVideo } from './h3/library.js';
import type { VideoService } from './h3/service.js';
import { NO_KEY_MESSAGE } from './messages.js';
import type { MotionService } from './motion/service.js';
import { WorkflowBusyError, WorkflowService } from './workflows/service.js';
import { WorkflowNoKeyError } from './workflows/runner.js';

export { NO_KEY_MESSAGE } from './messages.js';

/** 写死只听本机回环地址 */
export const LISTEN_HOST = '127.0.0.1';

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
  /** 剪辑服务;不给就没有剪辑工具 */
  editor?: VideoEditor;
  /** 代码渲染服务;不给就没有 render_motion 工具 */
  motion?: MotionService;
  /** 工作流库;不给就没有 /api/workflows 接口和 save_workflow 工具 */
  workflows?: WorkflowService;
  /** 云端生成(BYOK);不给就没有 /api/cloud 接口和云端工具 */
  cloud?: CloudService;
  /** 用户设置(档位开关);不给就一律按默认值 */
  settings?: SettingsStore;
}

export interface Host {
  server: Server;
  port: number;
  launchUrl: string;
  /** 换模型(桌面壳在设置页存了新 key 时调用);需要抹掉的秘密一并换掉 */
  setModel(model: LanguageModel | null, secrets: string[]): void;
  /** 只换「要抹掉的秘密」(云端 key 变了但 LLM 没变时用) */
  setSecrets(secrets: string[]): void;
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

/** 云端两家各自配没配 key(给页面判断要不要显示云端入口) */
function cloudKeyFlags(cloud: CloudService | undefined): { video: boolean; image: boolean } {
  const flags = { video: false, image: false };
  for (const p of cloud?.status().providers ?? []) flags[p.kind] = p.configured;
  return flags;
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
      const force = opts.settings?.get().forceNoLocalGpu === true;
      const gpu = withForcedTier(await probeGpu(opts.runNvidiaSmi), force);
      sendJson(res, 200, {
        hasApiKey: model !== null,
        tier: gpu.tier,
        forcedNoLocalGpu: force,
        cloud: cloudKeyFlags(opts.cloud),
      });
      return;
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      let body: unknown = null;
      try {
        body = await readJson(req);
      } catch {
        body = null;
      }
      const force = (body as { forceNoLocalGpu?: unknown } | null)?.forceNoLocalGpu;
      if (!opts.settings || typeof force !== 'boolean') {
        sendJson(res, 400, { error: 'bad_request', message: '需要 { forceNoLocalGpu: true 或 false }。' });
        return;
      }
      sendJson(res, 200, opts.settings.set({ forceNoLocalGpu: force }));
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
        const reply = await runChat(model, messages, {
          runNvidiaSmi: opts.runNvidiaSmi,
          video: opts.video,
          editor: opts.editor,
          motion: opts.motion,
          workflows: opts.workflows,
          cloud: opts.cloud,
          forceNoLocalGpu: opts.settings?.get().forceNoLocalGpu === true,
        });
        sendJson(res, 200, reply);
      } catch (err) {
        console.error('[vidroom] 调用 LLM 失败:', redact(err instanceof Error ? err.message : String(err), secrets));
        sendJson(res, 502, { error: 'llm_error', message: '调用 LLM 失败,请稍后再试或检查 API key。' });
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
    if (opts.workflows && (await handleWorkflowApi(opts.workflows, req, res, pathname))) return;
    if (opts.cloud && (await handleCloudApi(opts.cloud, req, res, pathname))) return;

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
      opts.workflows?.setModel(m);
      secrets = s;
    },
    setSecrets: (s) => {
      secrets = s;
    },
    close: async () => {
      await opts.comfy?.stop();
      await new Promise<void>((ok, fail) => server.close((e) => (e ? fail(e) : ok())));
    },
  };
}

/**
 * 云端生成接口。**唯一会让用户花钱的入口** —— 只有这里(以及它调的服务)真的发请求:
 * 聊天里的工具只估价,用户在页面估价卡上点确认后,页面才带着同一份参数打这里。
 * 所以 body 里必须显式带 confirm:true,免得别处顺手打进这个路由就把钱花了。
 */
async function handleCloudApi(cloud: CloudService, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const method = req.method;
  if (pathname === '/api/cloud' && method === 'GET') {
    sendJson(res, 200, cloud.status());
    return true;
  }
  if (pathname === '/api/cloud/generate' && method === 'POST') {
    let body: unknown = null;
    try {
      body = await readJson(req);
    } catch {
      body = null;
    }
    const b = body as { confirm?: unknown; kind?: unknown; prompt?: unknown; seconds?: unknown; resolution?: unknown; count?: unknown } | null;
    if (b?.confirm !== true) {
      sendJson(res, 400, { error: 'needs_confirmation', message: '云端生成要花钱,请求里必须带 confirm:true(用户点确认后才发)。' });
      return true;
    }
    const kind = b.kind;
    try {
      const result =
        kind === 'video'
          ? await cloud.generateVideo({
              prompt: String(b.prompt ?? ''),
              seconds: typeof b.seconds === 'number' ? b.seconds : undefined,
              resolution: b.resolution === '1080p' ? '1080p' : b.resolution === '720p' ? '720p' : undefined,
            })
          : kind === 'image'
            ? await cloud.generateImage({ prompt: String(b.prompt ?? ''), count: typeof b.count === 'number' ? b.count : undefined })
            : null;
      if (result === null) {
        sendJson(res, 400, { error: 'bad_request', message: 'kind 只能是 video 或 image。' });
        return true;
      }
      sendJson(res, result.ok ? 200 : 502, result);
    } catch (err) {
      sendJson(res, 400, { error: 'bad_request', message: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  const image = /^\/api\/cloud\/images\/([\w-]+)\.png$/.exec(pathname);
  if (image && method === 'GET') {
    const file = cloud.imagePath(image[1]);
    const size = file ? await stat(file).then((s) => s.size, () => null) : null;
    if (!file || size === null) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': size, 'cache-control': 'no-store' });
    await pipeline(createReadStream(file), res);
    return true;
  }
  return false;
}

async function handleWorkflowApi(workflows: WorkflowService, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const method = req.method;
  if (pathname === '/api/workflows' && method === 'GET') {
    sendJson(res, 200, { workflows: await workflows.list() });
    return true;
  }
  if (pathname === '/api/workflows/job' && method === 'GET') {
    sendJson(res, 200, workflows.job());
    return true;
  }
  const source = /^\/api\/workflows\/([a-z0-9-]+)\/source$/.exec(pathname);
  if (source && method === 'GET') {
    try {
      sendJson(res, 200, { source: await workflows.source(source[1]) });
    } catch {
      sendJson(res, 404, { error: 'not_found' });
    }
    return true;
  }
  if (source && method === 'PUT') {
    let body: unknown;
    try {
      body = await readJson(req);
      const text = String((body as { source?: unknown })?.source ?? '');
      sendJson(res, 200, { workflow: await workflows.saveSource(source[1], text) });
    } catch (err) {
      sendJson(res, 400, { error: 'bad_workflow', message: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  const run = /^\/api\/workflows\/([a-z0-9-]+)\/run$/.exec(pathname);
  if (run && method === 'POST') {
    let topic = '';
    try {
      topic = String(((await readJson(req)) as { topic?: unknown })?.topic ?? '').trim();
    } catch {
      // 当成空
    }
    if (!topic) {
      sendJson(res, 400, { error: 'bad_request', message: '需要 { topic }。' });
      return true;
    }
    try {
      sendJson(res, 202, await workflows.startRun(run[1], topic));
    } catch (err) {
      if (err instanceof WorkflowNoKeyError) sendJson(res, 503, { error: 'no_api_key', message: err.message });
      else if (err instanceof WorkflowBusyError) sendJson(res, 409, { error: 'workflow_busy', message: err.message });
      else sendJson(res, 400, { error: 'bad_workflow', message: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  return false;
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
    sendJson(res, 200, (await video.library().list()).map(publicVideo));
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
