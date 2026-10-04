/**
 * 给模型用的两个工具:出片、工作流库。
 * 注册进宿主的 tools 服务,插件卸载时一起摘掉。
 *
 * 返回值刻意做成面板卡片认得的形状(`kind: 'sync' | 'list' | 'text'`):
 * `render` 给模型读文字,`presentationMeta` 给网页端画卡片。
 */

import type { GenerateArgs } from './runner.js';
import { DEFAULT_ASPECT, DEFAULT_MEGAPIXELS } from './resolution.js';
import { describeSteps } from './runner.js';
import type { GenerationOutcome, VidroomRuntime, VidroomStatus } from './runtime.js';

/** 宿主 tools 服务的最小形状。 */
interface ToolsService {
  register(definition: unknown): () => void;
}

/** 插件这边对 Context 的最小要求(不 import 宿主的类型包)。 */
export interface HostContext {
  tools: ToolsService;
  get(service: string): unknown;
  effect(callback: () => unknown, label?: string): void;
  /** 等宿主声明出这些服务再回调(面板路由要 webServer);回调里拿到的 Context 由调用方自己声明形状。 */
  inject<T = unknown>(services: string[], callback: (ctx: T) => void): void;
}

/** 卡片里的一个产物。 */
interface CardMedia {
  kind: string;
  url: string;
  filename: string;
  subfolder: string;
  type: string;
}

/** 出片结果(工具返回值 + 卡片数据)。 */
interface VideoResult {
  kind: 'sync';
  promptId: string;
  status: 'completed';
  elapsedMs: number;
  media: CardMedia[];
  actual: { frames: number; seconds: number; width: number; height: number; megapixels: number };
  summary: string;
}

/** 工作流列表结果。 */
interface ListResult {
  kind: 'list';
  workflows: Array<{ slug: string; title: string; description: string; builtin: boolean; steps: string[] }>;
  env: VidroomStatus;
}

/** 读 SKILL.md 原文的结果。 */
interface TextResult {
  kind: 'text';
  slug: string;
  title: string;
  text: string;
}

/** 工具超时:出片是分钟级,给足。 */
const GENERATE_TIMEOUT_MS = 3_600_000;

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 把工具参数读成出片参数。 */
function readToolArgs(args: Record<string, unknown>): GenerateArgs {
  const prompt = str(args.prompt) ?? str(args.topic);
  if (prompt === undefined) throw new Error('vidroom_generate:要给 prompt(或 topic)');
  const seed = num(args.seed);
  return {
    prompt,
    seconds: num(args.seconds) ?? 5,
    megapixels: num(args.megapixels) ?? DEFAULT_MEGAPIXELS,
    aspect: str(args.aspect) ?? DEFAULT_ASPECT,
    ...(seed === undefined ? {} : { seed }),
  };
}

/** 出片结果 → 卡片/文字共用的形状。 */
function toVideoResult(outcome: GenerationOutcome): VideoResult {
  const seconds = Number(outcome.seconds.toFixed(2));
  const summary = `${outcome.width}x${outcome.height} · ${outcome.frames} 帧 · ${seconds} 秒 · 用时 ${(outcome.elapsedMs / 1000).toFixed(1)} 秒`;
  return {
    kind: 'sync',
    promptId: outcome.promptId,
    status: 'completed',
    elapsedMs: outcome.elapsedMs,
    media: outcome.media.map((item) => ({
      kind: item.kind,
      url: item.url,
      filename: item.filename,
      subfolder: item.subfolder,
      type: item.type,
    })),
    actual: {
      frames: outcome.frames,
      seconds,
      width: outcome.width,
      height: outcome.height,
      megapixels: Number(outcome.megapixels.toFixed(2)),
    },
    summary,
  };
}

/** 产物的文字清单(模型读这段)。 */
function mediaLines(media: CardMedia[]): string[] {
  return media.map((item) => `  ${item.kind}: ${item.url}`);
}

export function registerVidroomTools(ctx: HostContext, runtime: VidroomRuntime): Array<() => void> {
  const tools = ctx.tools;

  const generate = {
    name: 'vidroom_generate',
    description: [
      '用本机 ComfyUI 上的 MiniMax H3 出一段带声音的视频(本地生成,不走云端)。',
      '给一句 prompt(或 topic),可选 seconds(秒,默认 5,上限 15)、megapixels(百万像素,默认 0.4)、aspect(默认 "16:9")、seed(复现)。',
      '秒数会被吸附到 H3 的 17k+5 帧网格(说 7 秒给 175 帧);宽高由像素预算与长宽比算出并对齐 32 的倍数。',
      '出片是分钟级;返回里带 ComfyUI 的 prompt_id、产物文件名与播放地址。',
      '先跑 vidroom_workflows action: list 看本机状态(ComfyUI 地址、显存、是否放行)。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述(中文也行,H3 的多模态编码器接中文提示词)。' },
        topic: { type: 'string', description: 'prompt 的别名,二选一。' },
        seconds: { type: 'number', minimum: 0.2, maximum: 15, description: '成片时长(秒),默认 5;会吸附到 17k+5 帧。' },
        megapixels: {
          type: 'number',
          minimum: 0.05,
          maximum: 2,
          description: '像素预算(百万),默认 0.4;0.7 即 0.7MP。',
        },
        aspect: {
          type: 'string',
          enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'],
          description: '画面长宽比,默认 16:9。',
        },
        seed: { type: 'number', description: '随机种子;同一个种子 + 同一个 prompt 可复现。' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object' },
      render(_args: unknown, value: unknown): unknown[] {
        const result = value as VideoResult;
        const lines = [`本机 H3 出片完成(prompt_id=${result.promptId}):${result.summary}`, ...mediaLines(result.media)];
        return [{ type: 'text', text: lines.join('\n') }];
      },
      presentationMeta(_args: unknown, value: unknown): unknown {
        return value;
      },
    },
    timeoutMs: GENERATE_TIMEOUT_MS,
    async execute(args: Record<string, unknown>): Promise<unknown> {
      return toVideoResult(await runtime.generate(readToolArgs(args)));
    },
  };

  const workflows = {
    name: 'vidroom_workflows',
    description: [
      'VidRoom 的内置工作流库。action: list 列出内置工作流并带回本机状态(ComfyUI 地址、显存、准入结论);',
      'action: read { slug } 读某一份 SKILL.md 原文(含步骤);action: run { slug, topic, seconds?, megapixels?, aspect?, seed? } 按这份工作流出片并等结果。',
      '工作流是窄 DSL(只支持 generate_video 步骤);给的用户参数覆盖工作流里写死的同名参数。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'run'], description: '要做的事。' },
        slug: { type: 'string', description: '工作流的 slug(如 h3-t2v、h3-t2v-vertical)。read / run 必填。' },
        topic: { type: 'string', description: 'run:这一句主题(填进 {{topic}})。' },
        seconds: { type: 'number', description: 'run:覆盖工作流里的时长(秒)。' },
        megapixels: { type: 'number', description: 'run:覆盖工作流里的像素预算(百万)。' },
        aspect: { type: 'string', description: 'run:覆盖工作流里的长宽比。' },
        seed: { type: 'number', description: 'run:固定随机种子。' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render(_args: unknown, value: unknown): unknown[] {
        const result = value as ListResult | TextResult | VideoResult;
        if (result.kind === 'list') {
          const lines = [`内置工作流 ${result.workflows.length} 份:`];
          for (const workflow of result.workflows) {
            lines.push(`- ${workflow.slug}(${workflow.title}):${workflow.description}[${workflow.steps.join(' → ')}]`);
          }
          const env = result.env;
          lines.push(
            env.reachable
              ? `本机 ComfyUI ${env.baseUrl} 在:显存 ${env.vramTotalGiB?.toFixed(1) ?? '?'} GiB(空闲 ${env.vramFreeGiB?.toFixed(1) ?? '?'} GiB)。${env.admission.reason}`
              : `本机 ComfyUI ${env.baseUrl} 连不上:${env.error ?? '没有应答'}`,
          );
          return [{ type: 'text', text: lines.join('\n') }];
        }
        if (result.kind === 'text') {
          return [{ type: 'text', text: `# ${result.title}(${result.slug})\n\n${result.text}` }];
        }
        return [{ type: 'text', text: `工作流出片完成:${result.summary}\n${mediaLines(result.media).join('\n')}` }];
      },
      presentationMeta(_args: unknown, value: unknown): unknown {
        return value;
      },
    },
    timeoutMs: GENERATE_TIMEOUT_MS,
    async execute(args: Record<string, unknown>): Promise<unknown> {
      const action = str(args.action) ?? 'list';
      if (action !== 'list' && action !== 'read' && action !== 'run') {
        throw new Error(`vidroom_workflows:不认识 action ${action};能用的是 list / read / run`);
      }
      if (action === 'list') {
        const result: ListResult = {
          kind: 'list',
          workflows: runtime.workflows().map((workflow) => ({
            slug: workflow.slug,
            title: workflow.title,
            description: workflow.description,
            builtin: workflow.builtin,
            steps: describeSteps(workflow.steps),
          })),
          env: await runtime.status(),
        };
        return result;
      }

      const slug = str(args.slug);
      if (slug === undefined) throw new Error(`vidroom_workflows:action ${action} 要给 slug`);
      const workflow = runtime.workflow(slug);
      if (workflow === undefined) {
        throw new Error(`vidroom_workflows:没有 ${slug} 这份工作流;先 list 看有哪些`);
      }

      if (action === 'read') {
        const result: TextResult = { kind: 'text', slug: workflow.slug, title: workflow.title, text: workflow.text };
        return result;
      }

      const topic = str(args.topic);
      if (topic === undefined) throw new Error('vidroom_workflows:run 要给 topic');
      const seconds = num(args.seconds);
      const megapixels = num(args.megapixels);
      const aspect = str(args.aspect);
      const seed = num(args.seed);
      const overrides: Partial<GenerateArgs> = {
        ...(seconds === undefined ? {} : { seconds }),
        ...(megapixels === undefined ? {} : { megapixels }),
        ...(aspect === undefined ? {} : { aspect }),
        ...(seed === undefined ? {} : { seed }),
      };
      const { results } = await runtime.runWorkflow(workflow, { topic, overrides });
      const first = results[0];
      if (first === undefined) throw new Error(`vidroom_workflows:${slug} 没跑出任何产物`);
      const merged: GenerationOutcome = {
        ...first,
        media: results.flatMap((result) => result.media),
        elapsedMs: results.reduce((total, result) => total + result.elapsedMs, 0),
      };
      return toVideoResult(merged);
    },
  };

  return [tools.register(generate), tools.register(workflows)];
}
