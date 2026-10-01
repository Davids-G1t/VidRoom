export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
  output: unknown;
}

export type StatusResult =
  | {
      kind: 'ok';
      hasApiKey: boolean;
      /** 本机出片档位(none / unsupported / experimental / default)—— 老版本 Host 不返回 */
      tier?: string;
      /** 用户在设置里选了「不用本机显卡」 */
      forcedNoLocalGpu?: boolean;
      /** 云端两家配没配 key */
      cloud?: { video: boolean; image: boolean };
    }
  | { kind: 'unauthorized' }
  | { kind: 'error' };

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
    return {
      kind: 'ok',
      hasApiKey: Boolean(body.hasApiKey),
      tier: typeof body.tier === 'string' ? body.tier : undefined,
      forcedNoLocalGpu: body.forcedNoLocalGpu === true,
      cloud:
        typeof body.cloud === 'object' && body.cloud !== null
          ? { video: body.cloud.video === true, image: body.cloud.image === true }
          : undefined,
    };
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

// ---- 工作流库 ----
export interface WorkflowSummary {
  id: string;
  name: string;
  title: string;
  description: string;
  builtin: boolean;
  steps: number;
  updatedAt: string | null;
}

export type WorkflowJob =
  | { state: 'idle' }
  | { state: 'running'; workflowId: string; topic: string; steps: Array<{ id: string; tool: string; state: string; note?: string }> }
  | { state: 'done'; workflowId: string; topic: string; steps: Array<{ id: string; tool: string; state: string; note?: string }>; video?: VideoRecord }
  | { state: 'error'; workflowId: string; topic: string; steps: Array<{ id: string; tool: string; state: string; note?: string }>; error: string };

export async function fetchWorkflows(): Promise<WorkflowSummary[]> {
  const body = await getJson<{ workflows: WorkflowSummary[] }>('/api/workflows');
  return Array.isArray(body?.workflows) ? body.workflows : [];
}

export async function fetchWorkflowSource(id: string): Promise<string | null> {
  const body = await getJson<{ source: string }>(`/api/workflows/${encodeURIComponent(id)}/source`);
  return typeof body?.source === 'string' ? body.source : null;
}

export async function saveWorkflowSource(id: string, source: string): Promise<{ ok: true; workflow: WorkflowSummary } | { ok: false; message: string }> {
  try {
    const res = await fetch(`/api/workflows/${encodeURIComponent(id)}/source`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
    const body = await res.json();
    if (!res.ok) return { ok: false, message: body.message ?? `保存失败(${res.status})` };
    return { ok: true, workflow: body.workflow };
  } catch {
    return { ok: false, message: '连不上 VidRoom Host。' };
  }
}

export async function runWorkflow(id: string, topic: string): Promise<{ ok: true; job: WorkflowJob } | { ok: false; message: string }> {
  try {
    const res = await fetch(`/api/workflows/${encodeURIComponent(id)}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic }) });
    const body = await res.json();
    if (!res.ok) return { ok: false, message: body.message ?? `运行失败(${res.status})` };
    return { ok: true, job: body as WorkflowJob };
  } catch {
    return { ok: false, message: '连不上 VidRoom Host。' };
  }
}

export async function fetchWorkflowJob(): Promise<WorkflowJob | null> {
  const body = await getJson<WorkflowJob>('/api/workflows/job');
  return body && typeof body.state === 'string' ? body : null;
}

/** 工作流运行中/待确认的云端估价,给设置页和估价卡用 */
export type CloudKind = 'video' | 'image';

export interface CloudProviderStatus {
  kind: CloudKind;
  label: string;
  model: string;
  configured: boolean;
  /** 去哪申请 key(页面只显示链接,不收地址参数) */
  consoleUrl: string;
  keyHint: string;
}

export interface CloudStatus {
  providers: CloudProviderStatus[];
  prices: { videoCentsPerSecond: Record<'720p' | '1080p', number>; imageCentsPerImage: number };
}

/** 云端参数(估价工具原样带回来的那一份,确认时原样发回去) */
export type CloudRequest =
  | { kind: 'video'; prompt: string; seconds: number; resolution: '720p' | '1080p' }
  | { kind: 'image'; prompt: string; count: number };

export type CloudGenerateResult =
  | { ok: true; kind: 'video'; video: VideoRecord }
  | { ok: true; kind: 'image'; image: { id: string; file: string } }
  | { ok: false; reason: string };

export async function fetchCloud(): Promise<CloudStatus | null> {
  const body = await getJson<CloudStatus>('/api/cloud');
  return Array.isArray(body?.providers) ? body : null;
}

/**
 * 真的花钱的那一下:只有用户在估价卡上点确认才会调这里。
 * confirm:true 是 Host 的闸 —— 少了它一律 400。
 */
export async function generateCloud(request: CloudRequest): Promise<CloudGenerateResult> {
  try {
    const res = await fetch('/api/cloud/generate', post({ confirm: true, ...request }));
    const body = await res.json();
    if (!res.ok && body?.reason === undefined) return { ok: false, reason: body?.message ?? `云端生成失败(${res.status})` };
    return body as CloudGenerateResult;
  } catch {
    return { ok: false, reason: '连不上 VidRoom Host。' };
  }
}

/** 本机设置(目前只有「不用本机显卡」开关) */
export interface AppSettings {
  forceNoLocalGpu: boolean;
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings | null> {
  return getJson<AppSettings>('/api/settings', post(patch));
}

/** 许可原文随聊天页一起分发(public/licenses/) */
export async function fetchText(path: string): Promise<string | null> {
  try {
    const res = await fetch(path);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}
