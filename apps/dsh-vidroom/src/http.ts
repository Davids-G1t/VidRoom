/** 同源路由用的小工具。 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 发一个 no-store 的 JSON 响应。 */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

/** 读 JSON 请求体;空体返回 undefined。 */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  return JSON.parse(text) as unknown;
}

/** 请求是否来自同一个页面(Origin 与 Host 比)。 */
export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined) return true;
  if (host === undefined) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

/** 未知异常 → 人话。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
