export type LlmProvider = 'deepseek' | 'anthropic';

/** 桌面版 preload 暴露的接口(apps/desktop/src/preload.ts)。浏览器里打开时没有。 */
export interface DesktopApi {
  /** configured = 当前选用的那家有没有 key;providers = 每家有没有存 key */
  getKeyStatus(): Promise<{ configured: boolean; provider: LlmProvider; providers: Record<LlmProvider, boolean> }>;
  /** 给某家存 key,并切换成用这家 */
  setKey(key: string, provider: LlmProvider): Promise<{ ok: true } | { ok: false; message: string }>;
  /** 切换用哪家(那家没存 key 就等于没配置) */
  setProvider(provider: LlmProvider): Promise<{ ok: true } | { ok: false; message: string }>;
  /** 云端两家(生视频/生图)各自配没配 key;页面只能问这个,拿不回 key 本身 */
  getCloudKeyStatus(): Promise<{ video: boolean; image: boolean }>;
  /** 给云端某家存一份 key(存完立刻交给 Host,不用重启) */
  setCloudKey(key: string, kind: 'video' | 'image'): Promise<{ ok: true } | { ok: false; message: string }>;
  /** 在系统默认浏览器里打开 ComfyUI(地址由主进程向 Host 查,不信页面给的) */
  openComfyUI(): Promise<{ ok: true; url: string } | { ok: false; message: string }>;
  /** 在系统默认浏览器里打开「举报滥用」issue 模板(地址写死在主进程里,不收页面参数) */
  openAbuseReport(): Promise<void>;
}

declare global {
  interface Window {
    vidroom?: DesktopApi;
  }
}

export function desktopApi(): DesktopApi | undefined {
  return window.vidroom;
}
