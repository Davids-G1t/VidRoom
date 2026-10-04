/**
 * 面板用的 HTTP 面。面板是宿主页面里的一块,所以这里只挂同源 JSON 路由,
 * 自己不开端口、不碰 CORS —— 出片是分钟级,点「运行」只登记一条记录并立刻返回,
 * 进度靠轮询 /vidroom/run?id=。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorMessage, readJsonBody, sameOrigin, sendJson } from './http.js';
import { DEFAULT_ASPECT, DEFAULT_MEGAPIXELS } from './resolution.js';
import { describeSteps, type GenerateArgs } from './runner.js';
import type { VidroomRuntime } from './runtime.js';

/** 宿主 webServer 服务的最小形状。 */
export interface WebServerService {
  register(route: {
    kind: 'exact';
    path: string;
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  }): () => void;
}

/** 路由需要的上下文。 */
export interface RouteContext {
  webServer: WebServerService;
}

/** 面板路由的前缀。 */
export const ROUTE_PREFIX = '/vidroom';

/** 一份工作流给面板看的摘要。 */
function workflowSummary(workflow: ReturnType<VidroomRuntime['workflows']>[number]) {
  const generateStep = workflow.steps.find((step) => step.tool === 'generate_video');
  const args = generateStep?.args ?? {};
  const pick = (key: string, fallback: number | string): number | string => {
    const value = args[key];
    return typeof value === 'number' || typeof value === 'string' ? value : fallback;
  };
  return {
    slug: workflow.slug,
    title: workflow.title,
    description: workflow.description,
    builtin: workflow.builtin,
    steps: describeSteps(workflow.steps),
    defaults: {
      seconds: pick('seconds', 5),
      megapixels: pick('megapixels', DEFAULT_MEGAPIXELS),
      aspect: pick('aspect', DEFAULT_ASPECT),
    },
  };
}

function numberOr(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** 把请求体读成面板运行的入参。 */
function readRunInput(body: unknown): { slug: string; topic: string; overrides: Partial<GenerateArgs> } {
  if (body === null || typeof body !== 'object') throw new Error('请求体要是对象');
  const raw = body as Record<string, unknown>;
  const slug = stringOr(raw.slug, undefined);
  const topic = stringOr(raw.topic, undefined);
  if (slug === undefined) throw new Error('要给 slug');
  if (topic === undefined) throw new Error('要给 topic(这一句主题)');
  const seconds = numberOr(raw.seconds, undefined);
  const megapixels = numberOr(raw.megapixels, undefined);
  const aspect = stringOr(raw.aspect, undefined);
  const seed = numberOr(raw.seed, undefined);
  return {
    slug,
    topic,
    overrides: {
      ...(seconds === undefined ? {} : { seconds }),
      ...(megapixels === undefined ? {} : { megapixels }),
      ...(aspect === undefined ? {} : { aspect }),
      ...(seed === undefined ? {} : { seed }),
    },
  };
}

/** 一次请求里把 error 变成 4xx/5xx。 */
async function guard(response: ServerResponse, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = errorMessage(error);
    const status = message.includes('要给') || message.includes('没有') ? 400 : 500;
    sendJson(response, status, { ok: false, error: message });
  }
}

/** 挂上全部面板路由,返回摘除函数。 */
export function mountVidroomRoutes(ctx: RouteContext, runtime: VidroomRuntime): Array<() => void> {
  const handlers: Array<
    [string, (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void> | void]
  > = [
    [
      `${ROUTE_PREFIX}/workflows`,
      async (request, response) => {
        await guard(response, async () => {
          sendJson(response, 200, {
            ok: true,
            workflows: runtime.workflows().map(workflowSummary),
            env: await runtime.status(),
          });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/workflow`,
      async (request, response, url) => {
        await guard(response, () => {
          const slug = url.searchParams.get('slug') ?? '';
          const workflow = runtime.workflow(slug);
          if (workflow === undefined) throw new Error(`没有 ${slug} 这份工作流`);
          sendJson(response, 200, {
            ok: true,
            workflow: {
              slug: workflow.slug,
              title: workflow.title,
              description: workflow.description,
              steps: describeSteps(workflow.steps),
              /** SKILL.md 原文。 */
              text: workflow.text,
            },
          });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/status`,
      async (request, response) => {
        await guard(response, async () => {
          sendJson(response, 200, { ok: true, status: await runtime.status() });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/run`,
      async (request, response, url) => {
        if (request.method === 'GET') {
          await guard(response, () => {
            const id = url.searchParams.get('id');
            if (id === null) {
              sendJson(response, 200, { ok: true, runs: runtime.runs.list() });
              return;
            }
            const run = runtime.runs.get(id);
            if (run === undefined) throw new Error(`没有 ${id} 这条运行记录`);
            sendJson(response, 200, { ok: true, run });
          });
          return;
        }
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: '只支持 GET 与 POST' });
          return;
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, error: '只接受同源请求' });
          return;
        }
        await guard(response, async () => {
          const input = readRunInput(await readJsonBody(request));
          sendJson(response, 200, { ok: true, run: runtime.startRun(input) });
        });
      },
    ],
  ];

  return handlers.map(([path, handler]) =>
    ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (request, response) => {
        const url = new URL(request.url ?? path, `http://${request.headers.host ?? 'localhost'}`);
        return handler(request, response, url);
      },
    }),
  );
}
