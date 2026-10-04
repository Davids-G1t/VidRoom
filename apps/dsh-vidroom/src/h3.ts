/**
 * MiniMax H3 的文生视频模板与请求体构造。
 *
 * 模板是官方 Comfy-Org/workflow_templates 的文生视频图导成 API 格式后剪掉分支的产物
 * (来源与转换方式见 workflows/h3-t2v.json 的 `_source`)。每次出片只填四处:
 * 提示词、帧数、宽高、随机种子;其余节点与参数一律照模板。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidFrameCount } from './frames.js';
import { workflowsRoot } from './paths.js';

/** ComfyUI /prompt 的 prompt 字段:节点 id → { class_type, inputs }。 */
export type ApiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** 模板文件的结构。 */
export interface H3Template {
  _source: Record<string, string>;
  prompt: ApiPrompt;
}

/** 成片 MP4 里写的标注。ComfyUI 的 SaveVideo 会把 extra_pnginfo 的每个键写进容器元数据。 */
export const AI_GENERATED_TAG = 'AI-generated with MiniMax H3';

/** 模板里承载提示词/尺寸/帧数/种子的节点。 */
const H3_CONDITIONING_NODE = '140:131';
const H3_NOISE_NODE = '140:129';

let cached: H3Template | undefined;

/** 读一次模板(带缓存)。模板是只读的,调用方拿到的永远是深拷贝。 */
export function h3Template(): H3Template {
  if (cached === undefined) {
    const file = join(workflowsRoot(), 'h3-t2v.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as H3Template;
    if (parsed.prompt?.[H3_CONDITIONING_NODE] === undefined || parsed.prompt?.[H3_NOISE_NODE] === undefined) {
      throw new Error(`H3 模板 ${file} 少了必需节点(${H3_CONDITIONING_NODE} / ${H3_NOISE_NODE})`);
    }
    cached = parsed;
  }
  return cached;
}

export class InvalidFrameCountError extends Error {
  constructor(readonly frames: number) {
    super(`帧数 ${frames} 不在 H3 的 17k+5 网格上(5、22、39、…、362),不提交`);
    this.name = 'InvalidFrameCountError';
  }
}

export interface H3Params {
  prompt: string;
  frames: number;
  width: number;
  height: number;
  seed: number;
}

/** 生成 /prompt 请求里的 prompt 字段。帧数不合法直接抛错 —— 非法帧数永远到不了 ComfyUI。 */
export function buildH3Prompt(params: H3Params): ApiPrompt {
  if (!isValidFrameCount(params.frames)) throw new InvalidFrameCountError(params.frames);
  if (params.prompt.trim() === '') throw new Error('提示词为空');
  const graph = structuredClone(h3Template().prompt);
  const conditioning = graph[H3_CONDITIONING_NODE];
  if (conditioning === undefined) throw new Error(`模板缺节点 ${H3_CONDITIONING_NODE}`);
  conditioning.inputs.prompt = params.prompt;
  conditioning.inputs.length = params.frames;
  conditioning.inputs.width = params.width;
  conditioning.inputs.height = params.height;
  const noise = graph[H3_NOISE_NODE];
  if (noise === undefined) throw new Error(`模板缺节点 ${H3_NOISE_NODE}`);
  noise.inputs.noise_seed = params.seed;
  return graph;
}

/** /prompt 的完整请求体。 */
export function buildPromptRequest(params: H3Params, clientId: string) {
  return {
    prompt: buildH3Prompt(params),
    client_id: clientId,
    extra_data: { extra_pnginfo: { comment: AI_GENERATED_TAG } },
  };
}

/** 随机种子。 */
export function randomSeed(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}
