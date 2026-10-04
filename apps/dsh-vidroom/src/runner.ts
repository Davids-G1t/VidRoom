/**
 * 工作流 runner。窄:只跑插件认得的工具(本批只有 `generate_video`),
 * 步骤之间靠 `{{…}}` 取值,不做通用编排。
 *
 * 取值支持三种:
 *   {{topic}}            运行时填的一句主题
 *   {{<步骤id>.<字段>}}   引用前面步骤的输出
 *   {{item.<字段>}}       只在 each 展开时可用
 * 整个值就是一个 `{{…}}` 时保留原类型(数字/数组),否则按字符串拼接。
 */

import type { LibraryWorkflow, WorkflowStep } from './library.js';

/** 一次生成的参数(runner 与工具共用的形状)。 */
export interface GenerateArgs {
  prompt: string;
  seconds: number;
  megapixels: number;
  aspect: string;
  seed?: number;
}

/** 出片结果:至少要给出 ComfyUI 的 prompt_id 与产物定位。 */
export interface GenerateResult {
  promptId: string;
  /** 产物文件在 ComfyUI 上的播放地址。 */
  url: string;
  /** 落到磁盘的文件名(ComfyUI 的 output 目录下)。 */
  filename: string;
}

/** 取值的环境。 */
export interface RunScope {
  topic: string;
  steps: Record<string, unknown>;
  item?: Record<string, unknown>;
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** 把 `{{…}}` 换成实际值;整串只有一个占位符时保留原类型。 */
export function resolveValue(value: unknown, scope: RunScope, where: string): unknown {
  if (typeof value !== 'string') return value;
  const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value);
  if (whole !== null) return lookup(whole[1] ?? '', scope, where);
  return value.replace(TEMPLATE, (_match, path: string) => String(lookup(path, scope, where)));
}

function lookup(path: string, scope: RunScope, where: string): unknown {
  const segments = path.trim().split('.');
  let cursor: unknown;
  const head = segments[0];
  if (head === 'topic') cursor = scope.topic;
  else if (head === 'item') cursor = scope.item;
  else cursor = scope.steps[head ?? ''];
  for (const segment of segments.slice(1)) {
    if (cursor === null || typeof cursor !== 'object') {
      throw new Error(`${where}:取不到 {{${path}}}`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === undefined) throw new Error(`${where}:取不到 {{${path}}}`);
  return cursor;
}

/** 解析出来的出片参数(缺项给默认值)。 */
export function readGenerateArgs(raw: Record<string, unknown>, scope: RunScope, where: string): GenerateArgs {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) resolved[key] = resolveValue(value, scope, where);
  const prompt = resolved.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error(`${where}:prompt 是空的`);
  return {
    prompt,
    seconds: typeof resolved.seconds === 'number' ? resolved.seconds : 5,
    megapixels: typeof resolved.megapixels === 'number' ? resolved.megapixels : 0.4,
    aspect: typeof resolved.aspect === 'string' ? resolved.aspect : '16:9',
    ...(typeof resolved.seed === 'number' ? { seed: resolved.seed } : {}),
  };
}

/** 跑一份工作流的入参。`overrides` 里的键覆盖步骤里写死的同名参数。 */
export interface RunOptions {
  topic: string;
  overrides?: Partial<GenerateArgs>;
}

/** 一步的产物在后续步骤里的形状:`<步骤id>` 拿到 `{ id, …字段 }`,`<步骤id>.ids` 拿到全部 id。 */
function stepOutput(results: GenerateResult[]): Record<string, unknown> {
  const first = results[0];
  return {
    id: first?.promptId,
    ids: results.map((result) => result.promptId),
    url: first?.url,
    filename: first?.filename,
    outputs: results,
  };
}

/** 跑一份工作流。任何一步出错就整体失败(不做部分成功)。 */
export async function runWorkflow<T extends GenerateResult>(
  workflow: LibraryWorkflow,
  options: RunOptions,
  generate: (args: GenerateArgs) => Promise<T>,
): Promise<{ steps: Record<string, unknown>; results: T[] }> {
  const scope: RunScope = { topic: options.topic, steps: {} };
  const all: T[] = [];
  const call = async (args: GenerateArgs): Promise<T> => generate({ ...args, ...options.overrides });
  for (const [index, step] of workflow.steps.entries()) {
    const where = `工作流 ${workflow.slug} 第 ${index + 1} 步(${step.id})`;
    if (step.tool !== 'generate_video') {
      throw new Error(`${where}:本批只支持 generate_video,用到了 ${step.tool}`);
    }
    const results: T[] = [];
    if (step.each === undefined) {
      results.push(await call(readGenerateArgs(step.args, scope, where)));
    } else {
      const expanded = resolveValue(step.each, scope, where);
      const items = Array.isArray(expanded) ? expanded : undefined;
      if (items === undefined) throw new Error(`${where}:each 要解析成数组,拿到 ${JSON.stringify(expanded)}`);
      for (const [itemIndex, item] of items.entries()) {
        const itemScope: RunScope = {
          ...scope,
          item: item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : { value: item },
        };
        results.push(await call(readGenerateArgs(step.args, itemScope, `${where}[${itemIndex}]`)));
      }
    }
    scope.steps[step.id] = stepOutput(results);
    all.push(...results);
  }
  return { steps: scope.steps, results: all };
}

/** 面板上要显示的步骤摘要(不跑,只给人看)。 */
export function describeSteps(steps: WorkflowStep[]): string[] {
  return steps.map((step) => (step.each === undefined ? step.tool : `${step.tool} × each(${step.each})`));
}
