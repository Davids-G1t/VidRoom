import type { CloudKeyKind } from '../../host/src/parent-ipc.js';
import type { LlmProvider } from '../../host/src/llm-provider.js';

/**
 * 页面能用的全部 IPC 通道。页面只能问「各家有没有 key、当前用哪家」、「给某家设置新 key」和「切换用哪家」,
 * 没有任何读 key 的通道;云端那两家(生视频/生图)同理,只能问「配没配」和「存一份新的」;
 * 另有「打开 ComfyUI」:不带参数,地址由主进程自己向 Host 查;
 * 「举报滥用」:不带参数,打开的地址写死在主进程里。
 */
export const IPC = {
  keyStatus: 'vidroom:key-status',
  setKey: 'vidroom:set-key',
  setProvider: 'vidroom:set-provider',
  cloudKeyStatus: 'vidroom:cloud-key-status',
  setCloudKey: 'vidroom:set-cloud-key',
  openComfyUI: 'vidroom:open-comfyui',
  openAbuseReport: 'vidroom:open-abuse-report',
} as const;

export type OpenComfyResult = { ok: true; url: string } | { ok: false; message: string };

export interface KeyStatus {
  /** 当前选用的那家有没有 key */
  configured: boolean;
  provider: LlmProvider;
  /** 每家有没有存 key */
  providers: Record<LlmProvider, boolean>;
}

export type SetKeyResult = { ok: true } | { ok: false; message: string };

/** 云端两家各自配没配 key(不问内容,也没有读回来的通道) */
export interface CloudKeysStatus {
  video: boolean;
  image: boolean;
}

export type { CloudKeyKind };
