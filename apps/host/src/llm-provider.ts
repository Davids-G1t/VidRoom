/**
 * 聊天可选的 LLM(两家走同一套工具)。单独一个无依赖的小文件:桌面壳主进程也要用,
 * 不能为了这几个常量把 AI SDK 打进主进程。
 */
export const LLM_PROVIDERS = ['deepseek', 'anthropic'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export const PROVIDER_LABELS: Record<LlmProvider, string> = { deepseek: 'DeepSeek', anthropic: 'Anthropic' };

export function isLlmProvider(v: unknown): v is LlmProvider {
  return typeof v === 'string' && (LLM_PROVIDERS as readonly string[]).includes(v);
}
