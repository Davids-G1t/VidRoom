/** 桌面版 preload 暴露的接口(apps/desktop/src/preload.ts)。浏览器里打开时没有。 */
export interface DesktopApi {
  getKeyStatus(): Promise<{ configured: boolean }>;
  setKey(key: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

declare global {
  interface Window {
    vidroom?: DesktopApi;
  }
}

export function desktopApi(): DesktopApi | undefined {
  return window.vidroom;
}
