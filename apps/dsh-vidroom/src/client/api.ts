/** 面板与工具卡片共用的同源 JSON 小工具。 */
export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

/** 路由失败时返回 `{ ok: false, error }`,这里统一把它抛出来。 */
export function unwrap<T>(payload: unknown): T {
  const data = payload as { ok?: unknown; error?: unknown };
  if (data.ok === false) throw new Error(typeof data.error === 'string' ? data.error : '请求失败');
  if (data.error !== undefined && data.error !== null) {
    if (typeof data.error === 'string') throw new Error(data.error);
  }
  return payload as T;
}
