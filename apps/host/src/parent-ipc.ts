import { isLlmProvider, type LlmProvider } from './llm-provider.js';

/**
 * 桌面壳(父进程)与 Host(fork 出来的子进程)之间 IPC 通道上的消息。
 * API key 只走这条通道:不进环境变量(/proc/<pid>/environ 可读),不进命令行参数(ps 可见)。
 */

/** 壳 → Host:设置(或清掉)当前选用的 LLM 和它的 key。第一条到了 Host 才开始监听。 */
export interface SetKeyMessage {
  type: 'set-key';
  provider: LlmProvider;
  apiKey: string | null;
}

/** Host → 壳 */
export type HostToParent =
  | { type: 'ready'; launchUrl: string }
  | { type: 'key-applied'; hasApiKey: boolean };

export function parseParentMessage(raw: unknown): SetKeyMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type, provider, apiKey } = raw as { type?: unknown; provider?: unknown; apiKey?: unknown };
  if (type !== 'set-key' || !isLlmProvider(provider)) return null;
  if (apiKey === null) return { type, provider, apiKey: null };
  if (typeof apiKey !== 'string' || apiKey.trim() === '') return null;
  return { type, provider, apiKey: apiKey.trim() };
}
