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

/** Host 里 ComfyUI 的状态(见 apps/host/src/comfyui/manager.ts) */
export type ComfyStatus =
  | { state: 'stopped' }
  | { state: 'installing'; phase: 'downloading' | 'extracting'; received?: number; total?: number }
  | { state: 'starting' }
  | { state: 'running'; port: number; url: string; devices: string[] }
  | { state: 'error'; message: string };

async function comfyRequest(path: string, method: 'GET' | 'POST'): Promise<ComfyStatus | null> {
  try {
    const res = await fetch(path, { method });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.state === 'string' ? (body as ComfyStatus) : null;
  } catch {
    return null;
  }
}

export const fetchComfy = () => comfyRequest('/api/comfyui', 'GET');
export const startComfy = () => comfyRequest('/api/comfyui/start', 'POST');
export const stopComfy = () => comfyRequest('/api/comfyui/stop', 'POST');

// ---- 出片(MiniMax H3)----

export const ABUSE_REPORT_URL = 'https://github.com/Davids-G1t/VidRoom/issues/new?template=abuse-report.yml';
export const USE_POLICY_URL = 'https://github.com/Davids-G1t/VidRoom/blob/main/docs/USE-POLICY.md';
export const H3_NOTICE_PATH = '/licenses/MiniMax-H3-NOTICE.txt';

export interface ModelFileStatus {
  folder: string;
  fileName: string;
  role: string;
  size: number;
  state: 'ok' | 'missing' | 'mismatch';
}

export type DownloadState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; file: string; received: number; total: number }
  | { state: 'done'; downloaded: string[] }
  | { state: 'error'; message: string };

export interface H3Status {
  license: { name: string; source: string; sha256: string; path: string };
  consent: { licenseSha256: string; acceptedAt: string } | null;
  models: ModelFileStatus[] | null;
  download: DownloadState;
  admission: { allowed: boolean; tier: string; reason: string };
}

export type JobState =
  | { state: 'idle' }
  | { state: 'preparing'; message: string }
  | { state: 'running'; node: string | null; value: number; max: number; startedAt: string }
  | { state: 'done'; videoId: string }
  | { state: 'error'; message: string }
  | { state: 'cancelled' };

export interface VideoRecord {
  id: string;
  /** HyperFrames = 代码渲染(不是 AI 生成) */
  model: 'MiniMax H3' | 'HyperFrames';
  prompt: string;
  frames: number;
  seconds: number;
  seed: number;
  createdAt: string;
  elapsedMs: number;
  peakVramMiB: number | null;
  peakRamMiB: number | null;
  metricsSimulated: boolean;
  motion?: { style: string; title: string; subtitle: string | null; shots: Array<{ label: string; start: number; end: number }> };
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(path, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

export async function fetchH3(inspectModels = false): Promise<H3Status | null> {
  const s = await getJson<H3Status>(inspectModels ? '/api/h3?models=1' : '/api/h3');
  return s && typeof s.admission === 'object' && typeof s.download === 'object' ? s : null;
}
export const acceptH3License = (licenseSha256: string) =>
  getJson<{ acceptedAt: string }>('/api/h3/consent', post({ licenseSha256 }));
export const startH3Download = () => getJson<DownloadState>('/api/h3/download', post());
export async function fetchJob(): Promise<JobState | null> {
  const j = await getJson<JobState>('/api/video/job');
  return j && typeof j.state === 'string' ? j : null;
}
export async function fetchVideos(): Promise<VideoRecord[]> {
  const v = await getJson<VideoRecord[]>('/api/videos');
  return Array.isArray(v) ? v : [];
}
export const videoFileUrl = (id: string) => `/api/videos/${encodeURIComponent(id)}/file`;

/** 许可原文随聊天页一起分发(public/licenses/) */
export async function fetchText(path: string): Promise<string | null> {
  try {
    const res = await fetch(path);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}
