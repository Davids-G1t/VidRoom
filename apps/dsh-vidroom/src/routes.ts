/**
 * 面板用的 HTTP 面。面板是宿主页面里的一块,所以这里只挂同源 JSON 路由,
 * 自己不开端口、不碰 CORS —— 出片是分钟级,点「运行」只登记一条记录并立刻返回,
 * 进度靠轮询 /vidroom/run?id=。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import { errorMessage, readJsonBody, sameOrigin, sendJson } from './http.js';
import {
  alignSegment,
  createProject,
  inspectProject,
  jobView,
  listAssets,
  listCandidates,
  listProjects,
  missingAssets,
  openProject,
  patchProject,
  planProject,
  projectDirOf,
  registerReference,
  replayablePath,
  startRender,
} from './project-ops.js';
import { readProject } from './project-io.js';
import { VidroomError, errorFacts } from './errors.js';
import { renderVariants, type VariantSpec } from './render.js';
import type { Budget, PatchOp } from './project.js';
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

/* ------------------------------------------------------------------ *
 * 第 2 批的工程面
 * ------------------------------------------------------------------ */

/** 把 VidroomError 映射成状态码(面板要能分清「你给错了」和「机器坏了」)。 */
function statusFor(error: unknown): number {
  const facts = errorFacts(error);
  switch (facts.code) {
    case 'PROJECT_NOT_FOUND':
    case 'RUN_NOT_FOUND':
      return 404;
    case 'ALREADY_RUNNING':
      return 409;
    case 'LOCAL_ONLY':
    case 'REFERENCE_LOCAL_REQUIRED':
      return 403;
    case 'BUDGET_EXCEEDED':
    case 'PROJECT_HASH_MISMATCH':
    case 'ALIGNMENT_REQUIRED':
      return 409;
    default:
      return 400;
  }
}

/** 工程面请求的错误出口。 */
async function guarded(response: ServerResponse, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (error) {
    const facts = errorFacts(error);
    sendJson(response, statusFor(error), { ok: false, code: facts.code, error: facts.message });
  }
}

function readPath(url: URL): string {
  const value = url.searchParams.get('path') ?? url.searchParams.get('projectPath');
  if (value === null || value.trim() === '') throw new VidroomError('PROJECT_INVALID', '要给 path(工程目录)');
  return value.trim();
}

/** 预览用的扩展名 → 类型表(只读回放,不解释脚本)。 */
const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 面板回放工程里的素材与成片:文件得**先认出是这个工程的资产或运行产物**
 * (`replayablePath`),再看工程根子树里的相对路径规则。只读 GET,不回写。带 Range 支持,<video> 才能拖进度。
 */
export function serveProjectFile(request: IncomingMessage, response: ServerResponse, file: string): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, error: '只支持 GET' }));
    return;
  }
  const size = statSync(file).size;
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': MEDIA_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };
  const range = request.headers.range;
  if (typeof range === 'string' && /^bytes=\d*-\d*$/.test(range.trim())) {
    const [rawStart, rawEnd] = range.trim().slice('bytes='.length).split('-');
    const start = rawStart === '' ? 0 : Number(rawStart);
    const end = rawEnd === undefined || rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
      response.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    response.end();
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': String(size) });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}

function budgetFrom(body: Record<string, unknown>, fallback: Budget): Budget {
  const raw = body.budget;
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new VidroomError('PROJECT_INVALID', 'budget 要是对象');
  return { ...fallback, ...(raw as Partial<Budget>) };
}

function strField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VidroomError('PROJECT_INVALID', `要给 ${key}`);
  }
  return value.trim();
}

/** 第 2 批的面板路由。 */
function projectHandlers(
  runtime: VidroomRuntime,
): Array<[string, (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void> | void]> {
  const config = runtime.config();
  return [
    [
      `${ROUTE_PREFIX}/projects`,
      (request, response) => {
        void guarded(response, () => {
          const projects = listProjects(config).map((item) =>
            item.view === undefined ? { projectPath: item.dir, error: item.error ?? '读不出来' } : item.view,
          );
          sendJson(response, 200, { ok: true, root: config.projectsRoot, projects });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/project`,
      (request, response, url) => {
        if (request.method === 'POST') {
          if (!sameOrigin(request)) {
            sendJson(response, 403, { ok: false, error: '只接受同源请求' });
            return;
          }
          void guarded(response, async () => {
            const body = (await readJsonBody(request)) as Record<string, unknown>;
            const action = typeof body.action === 'string' ? body.action : 'inspect';
            if (action === 'create') {
              const created = createProject(
                config,
                typeof body.projectId === 'string' ? body.projectId : undefined,
              );
              sendJson(response, 200, { ok: true, project: inspectProject(created.dir, created.project) });
              return;
            }
            if (action !== 'patch') throw new VidroomError('PROJECT_INVALID', `action 只能是 inspect/patch/create`);
            const dir = projectDirOf(strField(body, 'path'));
            const current = readProject(dir);
            const patch = body.patch;
            if (!Array.isArray(patch) || patch.length === 0) {
              throw new VidroomError('PROJECT_INVALID', 'patch 要是非空数组');
            }
            const result = patchProject(dir, current, {
              baseHash: typeof body.baseHash === 'string' ? body.baseHash : undefined,
              patch: patch as PatchOp[],
            });
            sendJson(response, 200, {
              ok: true,
              project: inspectProject(dir, result.project),
              changedPaths: result.changedPaths,
              invalidatedShotIds: result.invalidatedShotIds,
              alignmentRequired: result.alignmentRequired,
            });
          });
          return;
        }
        void guarded(response, () => {
          const dir = projectDirOf(readPath(url));
          const project = readProject(dir);
          const store = jobView(dir).runs ?? [];
          sendJson(response, 200, {
            ok: true,
            project: inspectProject(dir, project),
            candidates: listCandidates(project, { limit: 100 }).items,
            missingAssets: missingAssets(project, dir),
            runs: store,
          });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/plan`,
      (request, response, url) => {
        void guarded(response, async () => {
          const dir = projectDirOf(readPath(url));
          const project = readProject(dir);
          const target = url.searchParams.get('target');
          if (target !== 'candidates' && target !== 'final') {
            throw new VidroomError('PROJECT_INVALID', 'target 只能是 candidates 或 final');
          }
          const plan = await planProject(dir, project, target);
          sendJson(response, 200, { ok: true, plan });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/render`,
      (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: '只支持 POST' });
          return;
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, error: '只接受同源请求' });
          return;
        }
        void guarded(response, async () => {
          const body = (await readJsonBody(request)) as Record<string, unknown>;
          const mode = strField(body, 'mode');
          if (mode !== 'compose' && mode !== 'generate-missing') {
            throw new VidroomError('PROJECT_INVALID', 'mode 只能是 compose 或 generate-missing');
          }
          const dir = projectDirOf(strField(body, 'path'));
          const current = readProject(dir);
          const planHash = strField(body, 'planHash');
          if (planHash.trim() === '') {
            throw new VidroomError('PLAN_HASH_MISMATCH', '渲染要带 planHash(先 POST /vidroom/plan 拿一份),不带不跑');
          }
          const started = await startRender(runtime, {
            dir,
            mode,
            expectedProjectHash: typeof body.expectedProjectHash === 'string' ? body.expectedProjectHash : undefined,
            planHash,
            budget: budgetFrom(body, current.budget),
          });
          sendJson(response, 200, { ok: true, ...started, job: jobView(dir, started.runId) });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/job`,
      (request, response, url) => {
        void guarded(response, () => {
          const dir = projectDirOf(readPath(url));
          const runId = url.searchParams.get('runId') ?? url.searchParams.get('id') ?? undefined;
          sendJson(response, 200, { ok: true, ...jobView(dir, runId ?? undefined) });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/align`,
      (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: '只支持 POST' });
          return;
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, error: '只接受同源请求' });
          return;
        }
        void guarded(response, async () => {
          const body = (await readJsonBody(request)) as Record<string, unknown>;
          const dir = projectDirOf(strField(body, 'path'));
          const project = readProject(dir);
          const windows = Array.isArray(body.wordWindows) ? body.wordWindows : [];
          const view = alignSegment(dir, project, {
            segmentId: strField(body, 'segmentId'),
            assetId: strField(body, 'assetId'),
            audioHash: strField(body, 'audioHash'),
            scriptHash: strField(body, 'scriptHash'),
            wordWindows: windows.map((window) => {
              const item = window as Record<string, unknown>;
              return {
                tokenId: String(item.tokenId),
                startFrame: Math.trunc(Number(item.startFrame)),
                endFrame: Math.trunc(Number(item.endFrame)),
              };
            }),
          });
          sendJson(response, 200, { ok: true, alignment: view });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/reference`,
      (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: '只支持 POST' });
          return;
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, error: '只接受同源请求' });
          return;
        }
        void guarded(response, async () => {
          const body = (await readJsonBody(request)) as Record<string, unknown>;
          const view = await registerReference(config, {
            localPath: strField(body, 'localPath'),
            projectPath: typeof body.projectPath === 'string' ? body.projectPath : undefined,
            referenceUrl: typeof body.referenceUrl === 'string' ? body.referenceUrl : undefined,
          });
          sendJson(response, 200, { ok: true, reference: view });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/variants`,
      (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: '只支持 POST' });
          return;
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, error: '只接受同源请求' });
          return;
        }
        void guarded(response, async () => {
          const body = (await readJsonBody(request)) as Record<string, unknown>;
          const dir = projectDirOf(strField(body, 'path'));
          const project = readProject(dir);
          const variants = Array.isArray(body.variants) ? (body.variants as VariantSpec[]) : [];
          const action = typeof body.action === 'string' ? body.action : 'plan';
          if (action !== 'plan' && action !== 'run') {
            throw new VidroomError('PROJECT_INVALID', 'action 只能是 plan 或 run');
          }
          const target = body.target === 'final' ? 'final' : 'candidates';
          const batch = await renderVariants(runtime, project, {
            dir,
            target,
            variants,
            action,
            ...(typeof body.planHash === 'string' ? { planHash: body.planHash } : {}),
            ...(typeof body.expectedProjectHash === 'string'
              ? { expectedProjectHash: body.expectedProjectHash }
              : {}),
            budget: budgetFrom(body, project.budget),
          });
          sendJson(response, 200, { ok: true, batch });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/assets`,
      (request, response, url) => {
        void guarded(response, () => {
          const dir = projectDirOf(readPath(url));
          const project = readProject(dir);
          sendJson(response, 200, {
            ok: true,
            ...listAssets(dir, project, {
              cursor: url.searchParams.get('cursor') ?? undefined,
              limit: url.searchParams.get('limit') === null ? undefined : Number(url.searchParams.get('limit')),
            }),
          });
        });
      },
    ],
    [
      `${ROUTE_PREFIX}/media`,
      (request, response, url) => {
        void guarded(response, () => {
          const dir = projectDirOf(readPath(url));
          const project = readProject(dir);
          const relative = url.searchParams.get('asset') ?? url.searchParams.get('file');
          if (relative === null || relative.trim() === '') {
            throw new VidroomError('PROJECT_INVALID', '要给 asset(工程内的相对路径)');
          }
          serveProjectFile(request, response, replayablePath(dir, project, relative.trim()));
        });
      },
    ],
  ];
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

  const all = [...handlers, ...projectHandlers(runtime)];

  return all.map(([path, handler]) =>
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
