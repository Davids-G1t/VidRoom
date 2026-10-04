/**
 * 工具、路由、面板共用的运行面:上面的接口是形状,下面的 createVidroomRuntime 是真身
 * (把状态查询、生成、工作流、面板运行记录串起来)。测试可以直接用它,不需要过 apply()。
 */

import { AI_GENERATED_TAG, buildH3Prompt, randomSeed } from './h3.js';
import { ComfyUIClient, mediaKind } from './comfy.js';
import { h3Admission } from './admission.js';
import type { Admission } from './admission.js';
import type { Config } from './config.js';
import { H3_FPS, framesForSeconds } from './frames.js';
import { getWorkflow, listWorkflows } from './library.js';
import { resolutionFor } from './resolution.js';
import { runWorkflow } from './runner.js';
import type { GenerateArgs } from './runner.js';
import type { LibraryWorkflow } from './library.js';
import { RunRegistry } from './runs.js';
import type { RunRecord } from './runs.js';
import { errorMessage } from './http.js';
import type { MediaRef } from './comfy.js';

/** 一次出片的结果。 */
export interface GenerationOutcome {
  promptId: string;
  /** 首个产物的播放地址(ComfyUI /view)。 */
  url: string;
  /** 首个产物在 ComfyUI output 下的文件名。 */
  filename: string;
  /** 全部产物(kind 按扩展名判,面板据此挑播放器)。 */
  media: Array<MediaRef & { url: string; kind: 'video' | 'image' | 'audio' | 'other' }>;
  /** 实际提交的帧数(已吸附到 17k+5 网格)。 */
  frames: number;
  /** 实际时长(秒)。 */
  seconds: number;
  width: number;
  height: number;
  /** 实际像素数(百万)。 */
  megapixels: number;
  /** 从提交到出产物用了多久。 */
  elapsedMs: number;
}

/** 一次状态查询:面板与工具都用它先说清"这台机器现在能不能跑"。 */
export interface VidroomStatus {
  baseUrl: string;
  /** ComfyUI 是否答话。 */
  reachable: boolean;
  /** 答不上话时的原因。 */
  error?: string;
  vramTotalGiB?: number;
  vramFreeGiB?: number;
  admission: Admission;
}

/** 面板发起的运行:先拿 id,再轮询。 */
export interface PanelRunInput {
  slug: string;
  topic: string;
  overrides?: Partial<GenerateArgs>;
}

export interface VidroomRuntime {
  config(): Config;
  client(): ComfyUIClient;
  workflows(): LibraryWorkflow[];
  workflow(slug: string): LibraryWorkflow | undefined;
  /** 直接出片(工具与 runner 的共同底座)。 */
  generate(args: GenerateArgs): Promise<GenerationOutcome>;
  /** 按工作流跑,带上覆盖值,等出结果(工具用;面板用 startRun)。 */
  runWorkflow(
    workflow: LibraryWorkflow,
    input: { topic: string; overrides?: Partial<GenerateArgs> },
  ): Promise<{ results: GenerationOutcome[]; steps: Record<string, unknown> }>;
  /** 面板:登记一条记录并后台跑,立刻返回。 */
  startRun(input: PanelRunInput): RunRecord;
  runs: RunRegistry;
  status(force?: boolean): Promise<VidroomStatus>;
}

/** 把配置、ComfyUI 客户端、工作流库、执行记录绑成一个运行面。 */
export function createVidroomRuntime(config: Config, runs: RunRegistry = new RunRegistry()): VidroomRuntime {
  const client = new ComfyUIClient(config.baseUrl, config.timeoutMs, config.pollIntervalMs);
  let statsAt = 0;
  let stats: VidroomStatus | undefined;

  /** 读一次机器状态(显存),60 秒内复用。 */
  async function status(force = false): Promise<VidroomStatus> {
    if (!force && stats !== undefined && Date.now() - statsAt < 60_000) return stats;
    try {
      const raw = await client.systemStats();
      const admission: Admission = h3Admission(raw.vramTotalGiB, config.allowExperimental);
      stats = {
        baseUrl: config.baseUrl,
        reachable: true,
        ...(raw.vramTotalGiB === undefined ? {} : { vramTotalGiB: raw.vramTotalGiB }),
        ...(raw.vramFreeGiB === undefined ? {} : { vramFreeGiB: raw.vramFreeGiB }),
        admission,
      };
    } catch (error) {
      stats = {
        baseUrl: config.baseUrl,
        reachable: false,
        error: errorMessage(error),
        admission: h3Admission(undefined, config.allowExperimental),
      };
    }
    statsAt = Date.now();
    return stats;
  }

  /** 出片:查机器 → 算帧数尺寸 → 提交 → 等产物。 */
  async function generate(args: GenerateArgs): Promise<GenerationOutcome> {
    const current = await status(true);
    if (!current.reachable) {
      throw new Error(`连不上 ComfyUI(${current.baseUrl}):${current.error ?? '没有应答'}`);
    }
    if (!current.admission.allowed) throw new Error(current.admission.reason);

    const frames = framesForSeconds(args.seconds);
    const resolution = resolutionFor(args.megapixels, args.aspect);
    const seed = args.seed ?? randomSeed();
    const promptId = await client.queue(
      buildH3Prompt({ prompt: args.prompt, frames, width: resolution.width, height: resolution.height, seed }),
      { comment: AI_GENERATED_TAG },
    );
    const done = await client.waitForCompletion(promptId);
    if (done.status === 'error') {
      throw new Error(`ComfyUI 跑失败(prompt_id=${promptId}):${done.error ?? '没给原因'}`);
    }
    const media = done.media.map((ref) => ({ ...ref, url: client.viewUrl(ref), kind: mediaKind(ref.filename) }));
    const first = media[0];
    if (first === undefined) {
      throw new Error(`ComfyUI 说跑完了,但没找到产物文件(prompt_id=${promptId})`);
    }
    return {
      promptId,
      url: first.url,
      filename: first.filename,
      media,
      frames,
      seconds: frames / H3_FPS,
      width: resolution.width,
      height: resolution.height,
      megapixels: resolution.megapixels,
      elapsedMs: done.elapsedMs,
    };
  }

  return {
    config: () => config,
    client: () => client,
    workflows: () => listWorkflows(),
    workflow: (slug: string) => getWorkflow(slug),
    generate,
    runWorkflow: (workflow, input) => runWorkflow(workflow, input, generate),
    startRun(input: PanelRunInput) {
      const workflow = getWorkflow(input.slug);
      if (workflow === undefined) throw new Error(`没有 ${input.slug} 这份工作流`);
      const record = runs.start({ slug: workflow.slug, title: workflow.title, topic: input.topic });
      void (async () => {
        try {
          const { results } = await runWorkflow(workflow, { topic: input.topic, overrides: input.overrides }, generate);
          runs.update(record.id, {
            status: 'success',
            promptIds: results.map((result) => result.promptId),
            media: results.flatMap((result) => result.media),
          });
        } catch (error) {
          runs.update(record.id, { status: 'error', error: errorMessage(error) });
        }
      })();
      return record;
    },
    runs,
    status,
  };
}
