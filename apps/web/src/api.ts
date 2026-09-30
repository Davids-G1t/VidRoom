export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
  output: unknown;
}

export type StatusResult = { kind: 'ok'; hasApiKey: boolean } | { kind: 'unauthorized' } | { kind: 'error' };

export type ChatResult =
  | { kind: 'ok'; text: string; toolCalls: ToolCallRecord[] }
  | { kind: 'no_api_key'; message: string }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string };

export async function fetchStatus(): Promise<StatusResult> {
  try {
    const res = await fetch('/api/status');
    if (res.status === 401) return { kind: 'unauthorized' };
    if (!res.ok) return { kind: 'error' };
    const body = await res.json();
    return { kind: 'ok', hasApiKey: Boolean(body.hasApiKey) };
  } catch {
    return { kind: 'error' };
  }
}

export async function sendChat(messages: ChatMessage[]): Promise<ChatResult> {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    if (res.status === 401) return { kind: 'unauthorized' };
    const body = await res.json();
    if (res.status === 503 && body.error === 'no_api_key') return { kind: 'no_api_key', message: body.message };
    if (!res.ok) return { kind: 'error', message: body.message ?? `请求失败(${res.status})` };
    return { kind: 'ok', text: body.text, toolCalls: body.toolCalls ?? [] };
  } catch {
    return { kind: 'error', message: '连不上 VidRoom Host。' };
  }
}
