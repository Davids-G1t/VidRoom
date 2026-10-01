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

/** 云端两家(生视频/生图)的 key;与 LLM key 相互独立,null = 清掉 */
export type CloudKeyKind = 'video' | 'image';

export interface SetCloudKeysMessage {
  type: 'set-cloud-keys';
  keys: Record<CloudKeyKind, string | null>;
}

/** 壳 → Host 的全部消息 */
export type ParentMessage = SetKeyMessage | SetCloudKeysMessage;

/** Host → 壳 */
export type HostToParent =
  | { type: 'ready'; launchUrl: string }
  | { type: 'key-applied'; hasApiKey: boolean }
  | { type: 'cloud-keys-applied' };

export function parseParentMessage(raw: unknown): ParentMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type } = raw as { type?: unknown };
  if (type === 'set-cloud-keys') {
    const keys = (raw as { keys?: unknown }).keys;
    if (typeof keys !== 'object' || keys === null) return null;
    const parsed = {} as Record<CloudKeyKind, string | null>;
    for (const kind of ['video', 'image'] as const) {
      const value = (keys as Record<string, unknown>)[kind];
      if (value === null) parsed[kind] = null;
      else if (typeof value === 'string' && value.trim() !== '') parsed[kind] = value.trim();
      else return null;
    }
    return { type, keys: parsed };
  }
  const { provider, apiKey } = raw as { provider?: unknown; apiKey?: unknown };
  if (type !== 'set-key' || !isLlmProvider(provider)) return null;
  if (apiKey === null) return { type, provider, apiKey: null };
  if (typeof apiKey !== 'string' || apiKey.trim() === '') return null;
  return { type, provider, apiKey: apiKey.trim() };
}
