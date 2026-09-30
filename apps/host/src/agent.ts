import { createDeepSeek } from '@ai-sdk/deepseek';
import { generateText, isStepCount, tool, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import { probeGpu, type RunNvidiaSmi } from './gpu.js';

export const DEEPSEEK_MODEL = 'deepseek-v4-flash';

export const SYSTEM_PROMPT = [
  '你是 VidRoom 的助手。VidRoom 在用户自己的 NVIDIA 显卡上用 ComfyUI 本地生成视频。',
  '凡是涉及用户电脑硬件、显卡、显存、「这台电脑能跑什么」之类的问题,必须先调用 probe_gpu 工具,',
  '只根据工具返回的结果回答,绝不凭空猜测或编造型号与显存。',
  '回答时写出显卡完整型号和显存(按整 GB 说,例如「16GB」),再用一两句话说明对应档位意味着什么。',
  '用简体中文回答,只输出纯文本,不要用 Markdown 标记(聊天页不渲染 Markdown)。',
].join('');

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
  output: unknown;
}

export interface ChatReply {
  text: string;
  /** 本次回答中实际执行的工具调用及其返回值(agent 可见的技术细节,也供测试核对) */
  toolCalls: ToolCallRecord[];
}

export function createTools(runNvidiaSmi?: RunNvidiaSmi) {
  return {
    probe_gpu: tool({
      description:
        '探测本机 NVIDIA 显卡:返回型号、显存(MiB 与四舍五入后的 GiB)和本地出片档位' +
        '(none / unsupported / experimental / default)。回答任何硬件或「能跑什么」的问题前都要调用。',
      inputSchema: z.object({}),
      execute: async () => probeGpu(runNvidiaSmi),
    }),
  };
}

export function createDeepSeekModel(apiKey: string): LanguageModel {
  return createDeepSeek({ apiKey })(DEEPSEEK_MODEL);
}

export async function runChat(
  model: LanguageModel,
  messages: ChatMessage[],
  runNvidiaSmi?: RunNvidiaSmi,
): Promise<ChatReply> {
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    messages: messages as ModelMessage[],
    tools: createTools(runNvidiaSmi),
    stopWhen: isStepCount(5),
  });
  const toolCalls = result.steps.flatMap((step) =>
    step.toolResults.map((r) => ({ toolName: r.toolName, input: r.input, output: r.output })),
  );
  return { text: result.text, toolCalls };
}
