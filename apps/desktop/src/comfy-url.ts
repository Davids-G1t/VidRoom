/**
 * 「打开 ComfyUI」要交给 shell.openExternal 的地址。只从 Host 的 /api/comfyui 状态里取端口,
 * 自己拼成 http://127.0.0.1:<端口>/ —— 不用状态里的 url 字段原文,更不用页面传来的任何东西,
 * 这样 openExternal 只可能打开本机回环地址。
 */
export function comfyUrlFromStatus(status: unknown): string | null {
  if (typeof status !== 'object' || status === null) return null;
  const { state, port } = status as { state?: unknown; port?: unknown };
  if (state !== 'running' || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://127.0.0.1:${port}/`;
}
