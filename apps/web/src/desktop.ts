/** 桌面版 preload 暴露的接口(apps/desktop/src/preload.ts)。浏览器里打开时没有。 */
export interface DesktopApi {
  getKeyStatus(): Promise<{ configured: boolean }>;
  setKey(key: string): Promise<{ ok: true } | { ok: false; message: string }>;
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
