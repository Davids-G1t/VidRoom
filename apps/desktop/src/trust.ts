/**
 * IPC 来源校验。这个文件不 import electron,方便单测。
 *
 * 页面只从 `vidroom-app://app/` 加载。每个 ipcMain.handle 开头都要过 assertTrustedSender:
 * 发送方必须是顶层框架(不是嵌进来的 iframe),而且当前地址是本应用自己的协议和主机名。
 * 不满足就拒绝并记日志。所有 handler 都经 main.ts 的 handleTrusted() 注册,不各写一遍判断。
 */

export const APP_SCHEME = 'vidroom-app';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/** Electron WebFrameMain 里用得到的那一小部分 */
export interface FrameLike {
  url: string;
  parent: FrameLike | null;
}

export interface SenderEventLike {
  senderFrame: FrameLike | null;
}

export function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST;
  } catch {
    return false;
  }
}

export function isTrustedSender(event: SenderEventLike): boolean {
  const frame = event.senderFrame;
  // senderFrame 为 null:发送后框架已经导航走或销毁,来源无法确认
  if (!frame) return false;
  if (frame.parent !== null) return false;
  return isAppUrl(frame.url);
}

export class UntrustedSenderError extends Error {
  constructor(channel: string) {
    super(`拒绝来自不可信来源的 IPC 调用:${channel}`);
  }
}

export function assertTrustedSender(
  event: SenderEventLike,
  channel: string,
  log: (msg: string) => void = console.warn,
): void {
  if (isTrustedSender(event)) return;
  const where = event.senderFrame ? `${event.senderFrame.url}${event.senderFrame.parent ? '(子框架)' : ''}` : '(框架已不存在)';
  log(`[vidroom-desktop] 拒绝 IPC ${channel}:来源 ${where} 不是 ${APP_ORIGIN}`);
  throw new UntrustedSenderError(channel);
}
