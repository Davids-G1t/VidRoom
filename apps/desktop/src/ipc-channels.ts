/** 页面能用的全部 IPC 通道。页面只能问「有没有 key」和「设置新 key」,没有任何读 key 的通道。 */
export const IPC = {
  keyStatus: 'vidroom:key-status',
  setKey: 'vidroom:set-key',
} as const;

export interface KeyStatus {
  configured: boolean;
}

export type SetKeyResult = { ok: true } | { ok: false; message: string };
