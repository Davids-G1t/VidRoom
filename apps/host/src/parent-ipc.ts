/**
 * 桌面壳(父进程)与 Host(fork 出来的子进程)之间 IPC 通道上的消息。
 * DeepSeek key 只走这条通道:不进环境变量(/proc/<pid>/environ 可读),不进命令行参数(ps 可见)。
 */

/** 壳 → Host:设置(或清掉)key。第一条到了 Host 才开始监听。 */
export interface SetKeyMessage {
  type: 'set-key';
  apiKey: string | null;
}

/** Host → 壳 */
export type HostToParent =
  | { type: 'ready'; launchUrl: string }
  | { type: 'key-applied'; hasApiKey: boolean };

export function parseParentMessage(raw: unknown): SetKeyMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type, apiKey } = raw as { type?: unknown; apiKey?: unknown };
  if (type !== 'set-key') return null;
  if (apiKey === null) return { type, apiKey: null };
  if (typeof apiKey !== 'string' || apiKey.trim() === '') return null;
  return { type, apiKey: apiKey.trim() };
}
