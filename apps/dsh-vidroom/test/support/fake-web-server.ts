/**
 * 假 webServer:真开一个 HTTP 服务,把宿主 webServer.register 进来的处理器按路径转过去。
 * 这样面板路由的测试走的是真请求真响应(同源判定、JSON 请求体都能照真)。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { WebServerService } from '../../src/routes.js';

export interface TestWebServer {
  service: WebServerService;
  baseUrl: string;
  /** 现在挂着几条路由(给卸载断言用)。 */
  count(): number;
  close(): Promise<void>;
}

export async function startTestWebServer(): Promise<TestWebServer> {
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const handler = routes.get(path);
    if (handler === undefined) {
      response.writeHead(404);
      response.end('没有这条路由');
      return;
    }
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('假 webServer 没拿到端口');

  return {
    service: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => {
          routes.delete(route.path);
        };
      },
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
    count: () => routes.size,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
