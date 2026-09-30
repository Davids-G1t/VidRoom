import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { APP_HOST } from './trust.js';

/**
 * vidroom-app:// 协议处理(不 import electron,方便单测):
 * - /api/* 转发给 Host(由 forwardApi 带上 session cookie);
 * - 其余路径从聊天页构建产物目录读静态文件,单页应用未知路径回落到 index.html。
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** 页面只允许加载本协议下的资源、只连本协议(/api 由协议处理器转发) */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export type ForwardApi = (
  pathAndQuery: string,
  init: { method: string; body?: ArrayBuffer; contentType: string | null },
) => Promise<Response>;

export interface AppProtocolDeps {
  webDir: string;
  forwardApi: ForwardApi;
}

export async function handleAppRequest(request: Request, deps: AppProtocolDeps): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== APP_HOST) return new Response('not found', { status: 404 });

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const upstream = await deps.forwardApi(url.pathname + url.search, {
      method: request.method,
      body: hasBody ? await request.arrayBuffer() : undefined,
      contentType: request.headers.get('content-type'),
    });
    // 只回状态码、正文和 content-type;Host 的其它响应头(包括任何 set-cookie)不给页面
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  return serveStatic(deps.webDir, url.pathname);
}

async function serveStatic(webDir: string, pathname: string): Promise<Response> {
  const root = resolve(webDir);
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  } catch {
    return new Response('bad request', { status: 400 });
  }
  let file = resolve(root, rel || 'index.html');
  if (file !== root && !file.startsWith(root + sep)) return new Response('not found', { status: 404 });
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    file = join(root, 'index.html');
    try {
      data = await readFile(file);
    } catch {
      return new Response('聊天页没有打包进来', { status: 404 });
    }
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const headers: Record<string, string> = { 'content-type': type };
  if (type.startsWith('text/html')) headers['content-security-policy'] = CONTENT_SECURITY_POLICY;
  return new Response(new Uint8Array(data), { status: 200, headers });
}
