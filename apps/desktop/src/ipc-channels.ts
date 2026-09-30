/**
 * 页面能用的全部 IPC 通道。页面只能问「有没有 key」和「设置新 key」,没有任何读 key 的通道;
 * 另有「打开 ComfyUI」:不带参数,地址由主进程自己向 Host 查。
 */
export const IPC = {
  keyStatus: 'vidroom:key-status',
  setKey: 'vidroom:set-key',
  openComfyUI: 'vidroom:open-comfyui',
} as const;

export type OpenComfyResult = { ok: true; url: string } | { ok: false; message: string };

export interface KeyStatus {
  configured: boolean;
}

export type SetKeyResult = { ok: true } | { ok: false; message: string };
