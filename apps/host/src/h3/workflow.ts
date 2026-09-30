import template from './workflows/h3-t2v.json' with { type: 'json' };
import { isValidFrameCount } from './frames.js';

/**
 * 锁定的官方文生视频模板(API 格式,来源与转换方式见 workflows/h3-t2v.json 的 _source)。
 * 每次出片只填三处:提示词、帧数、随机种子;其余节点与参数一律照模板。
 */

export type ApiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export const H3_WORKFLOW_SOURCE = template._source;

/** 成片 MP4 里写的标注。ComfyUI 的 SaveVideo 会把 extra_pnginfo 的每个键写成容器元数据(值经 json.dumps)。 */
export const AI_GENERATED_TAG = 'AI-generated with MiniMax H3';

export class InvalidFrameCountError extends Error {
  constructor(readonly frames: number) {
    super(`帧数 ${frames} 不在 H3 的 17k+5 网格上(5、22、39、…、362),不提交`);
  }
}

export interface H3Params {
  prompt: string;
  frames: number;
  seed: number;
}

/** 生成 /prompt 请求里的 prompt 字段。帧数不合法直接抛错 —— 非法帧数永远到不了 ComfyUI。 */
export function buildH3Prompt(p: H3Params): ApiPrompt {
  if (!isValidFrameCount(p.frames)) throw new InvalidFrameCountError(p.frames);
  if (!p.prompt.trim()) throw new Error('提示词为空');
  const graph = structuredClone(template.prompt) as ApiPrompt;
  const i2v = graph['140:131'].inputs;
  i2v.prompt = p.prompt;
  i2v.length = p.frames;
  graph['140:129'].inputs.noise_seed = p.seed;
  return graph;
}

/** /prompt 的完整请求体 */
export function buildPromptRequest(p: H3Params, clientId: string) {
  return {
    prompt: buildH3Prompt(p),
    client_id: clientId,
    extra_data: { extra_pnginfo: { comment: AI_GENERATED_TAG } },
  };
}
