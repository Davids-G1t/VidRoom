/**
 * H3 底座适配层(R1)。
 *
 * 第 1 批的 `vidroom_generate` 用的是「秒 + 像素预算 + 长宽比」这套预算式参数;
 * 本批要的是**精确运行请求**(帧数、宽、高、fps、seed、工作流哈希),因为工程文件里
 * 定的是确切的帧数与画幅 —— 少一帧、差 32 像素都会让时钟对不上。
 *
 * 所以这一层是**新入口**,不动第 1 批的签名与行为:`runtime.generate` 照旧,
 * 这里直接用第 1 批已经有的 `buildH3Prompt` + `ComfyUIClient` 走精确路径。
 * 准入(显存档、连不连得上)复用同一个闸,不绕过去。
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { mediaKind, type MediaRef } from './comfy.js';
import { VidroomError } from './errors.js';
import { H3_FPS, H3_MAX_FRAMES, H3_MIN_FRAMES, isValidFrameCount, secondsForFrames } from './frames.js';
import { AI_GENERATED_TAG, buildH3Prompt, h3Template, randomSeed, type ApiPrompt } from './h3.js';
import { ASPECT_RATIOS } from './resolution.js';
import { canonicalJson, sha256Of, type Locks } from './project.js';
import type { VidroomRuntime } from './runtime.js';

/** 本批只用这一份工作流图;`h3-t2v` 与工作流库里的 slug 同名。 */
export const H3_WORKFLOW_ID = 'h3-t2v';

/** 工作流图的哈希:图是仓里带的,同版本仓走哪台机器都是这个值。 */
export function h3WorkflowHash(): string {
  return sha256Of(canonicalJson(h3Template()));
}

/** 能力与参数快照(模型/工作流/输入域/本机就绪)。 */
export interface H3Capabilities {
  workflowId: string;
  workflowHash: string;
  inputSchema: Record<string, unknown>;
  defaults: { seed: 'random'; width: number; height: number; frames: number; fps: number };
  limits: {
    minFrames: number;
    maxFrames: number;
    frameRule: string;
    multipleOf: number;
    fps: number;
    aspects: string[];
  };
  /** 实测过的模型哈希;没量就是 null,不凭模型名补造。 */
  modelHashes: Array<{ file: string; sha256: string }> | null;
  /**
   * 机器那半:连得上 + 准入过 + (给了工程锁时)锁里点名的权重在盘上。
   * 权重只核「文件在不在」不核哈希 —— 哈希复核在 run 里做(那里有按大小+mtime 的缓存)。
   */
  localReady: boolean;
  /** 缺什么:每一条都让 `localReady` 为 false。 */
  reasons: string[];
  /** 没核到、也不下结论的(比如工程还没 lock):不影响 `localReady`,但得报出来,别当成就绪。 */
  notes: string[];
}

export interface CapabilityInput {
  locks?: Locks;
  reachable: boolean;
  admissionAllowed: boolean;
  admissionReason: string;
  /** 权重目录:用来核锁里点名的权重在不在盘上。不给就核不了,理由写进 notes。 */
  modelsRoot?: string | undefined;
}

/** 端上参数快照。`reasons` 里只要有一条,`localReady` 就是 false。 */
export function h3Capabilities(input: CapabilityInput): H3Capabilities {
  const reasons: string[] = [];
  const notes: string[] = [];
  if (!input.reachable) reasons.push('连不上本机 ComfyUI');
  if (!input.admissionAllowed) reasons.push(input.admissionReason);
  const models = input.locks?.models ?? [];
  if (input.locks === undefined) {
    // 还没 lock 就不知道要核哪几份权重:机器那半照报,权重那半只能标「没核」。
    notes.push('工程还没 lock:权重在不在盘上、工作流版本这半没核,别当成已核过');
  } else if (models.length === 0) {
    notes.push('lock 里没记模型哈希(lock 时没算),别按模型名猜');
  } else if (input.modelsRoot === undefined) {
    notes.push(`没配权重目录,核不了这 ${models.length} 份权重在不在盘上`);
  } else {
    const missing = models.filter((model) => !existsSync(isAbsolute(model.file) ? model.file : join(input.modelsRoot as string, model.file)));
    if (missing.length > 0) reasons.push(`权重不在盘上:${missing.map((model) => model.file).join('、')}`);
    if (missing.length < models.length) notes.push('权重只核了文件在不在,哈希复核在 run 里做');
  }
  return {
    workflowId: H3_WORKFLOW_ID,
    workflowHash: h3WorkflowHash(),
    inputSchema: {
      prompt: { type: 'string', required: true, note: '画面描述,中文可' },
      seed: { type: 'integer', note: '不给则随机;同 prompt + 同 seed 可复现' },
      width: { type: 'integer', multipleOf: 32 },
      height: { type: 'integer', multipleOf: 32 },
      frames: { type: 'integer', rule: `17k+5(${H3_MIN_FRAMES}–${H3_MAX_FRAMES})` },
      fps: { type: 'integer', const: H3_FPS },
      workflowHash: { type: 'string', note: '要核的图哈希' },
    },
    // 默认帧数要自己合 17k+5 网格(124 = 17×7+5),不然能力接口给的默认值会被自己的校验拒。
    defaults: { seed: 'random', width: 640, height: 384, frames: 124, fps: H3_FPS },
    limits: {
      minFrames: H3_MIN_FRAMES,
      maxFrames: H3_MAX_FRAMES,
      frameRule: '17k+5',
      multipleOf: 32,
      fps: H3_FPS,
      aspects: Object.keys(ASPECT_RATIOS),
    },
    modelHashes: models.length === 0 ? null : models,
    localReady: reasons.length === 0,
    reasons,
    notes,
  };
}

/** 精确运行请求。 */
export interface H3Request {
  prompt: string;
  seed?: number;
  width: number;
  height: number;
  frames: number;
  fps?: number;
  workflowId?: string;
  workflowHash?: string;
  /** 只为回执串联:这条请求属于哪次运行。 */
  outputRunId?: string;
}

export interface H3RunResult {
  jobId: string;
  promptId: string;
  effectiveParams: {
    workflowId: string;
    workflowHash: string;
    prompt: string;
    seed: number;
    width: number;
    height: number;
    frames: number;
    fps: number;
    seconds: number;
    outputRunId?: string;
  };
  state: 'succeeded';
  media: Array<MediaRef & { url: string; kind: 'video' | 'image' | 'audio' | 'other' }>;
  /** 实际提交的那张图(带真 seed):回执要拿它复现,不能靠重算。 */
  graph: ApiPrompt;
  filename: string;
  elapsedMs: number;
}

export interface H3JobStatus {
  jobId: string;
  state: 'pending' | 'succeeded' | 'failed';
  note?: string;
  media: Array<MediaRef & { url: string; kind: string }>;
  error?: string;
}

/** 参数域校验:不支持的尺寸/帧数/fps 一律报错,不静默吸到最近的合法值。 */
export function assertSupported(request: H3Request): void {
  const fps = request.fps ?? H3_FPS;
  if (request.workflowId !== undefined && request.workflowId !== H3_WORKFLOW_ID) {
    throw new VidroomError('UNSUPPORTED_PARAMS', `本批只有 ${H3_WORKFLOW_ID} 这一份图,收到 ${request.workflowId}`);
  }
  if (request.workflowHash !== undefined && request.workflowHash !== h3WorkflowHash()) {
    throw new VidroomError(
      'UNSUPPORTED_PARAMS',
      `工作流图对不上:工程里锁的是 ${request.workflowHash.slice(0, 12)},本机这份是 ${h3WorkflowHash().slice(0, 12)}`,
    );
  }
  if (fps !== H3_FPS) throw new VidroomError('UNSUPPORTED_PARAMS', `本机 H3 底座只跑 ${H3_FPS} fps,收到 ${fps}`);
  if (request.width % 32 !== 0 || request.height % 32 !== 0) {
    throw new VidroomError('UNSUPPORTED_PARAMS', `宽高要对齐 32 的倍数,收到 ${request.width}x${request.height}`);
  }
  if (!isValidFrameCount(request.frames)) {
    throw new VidroomError(
      'UNSUPPORTED_PARAMS',
      `帧数要落在 17k+5 网格上(${H3_MIN_FRAMES}–${H3_MAX_FRAMES}),收到 ${request.frames}`,
    );
  }
  if (request.seed !== undefined && (!Number.isInteger(request.seed) || request.seed < 0)) {
    throw new VidroomError('UNSUPPORTED_PARAMS', `seed 要是非负整数,收到 ${String(request.seed)}`);
  }
}

/** 提交一次精确生成并等结果(会先过准入闸)。
 * `hooks.onQueued` 在**刚投进队列**时叫一次(还没有结果):调用方靠它把 promptId 当场落盘 ——
 * 进程半路挂了也能拿着这个编号去查,不至于“提交过但不知道编号”。
 */
export async function h3Run(
  runtime: VidroomRuntime,
  request: H3Request,
  hooks: { onQueued?: (promptId: string) => void } = {},
): Promise<H3RunResult> {
  assertSupported(request);
  const status = await runtime.status(true);
  if (!status.reachable) {
    throw new VidroomError('LOCAL_ONLY', `连不上本机 ComfyUI(${status.baseUrl}):${status.error ?? '没有应答'}`);
  }
  if (!status.admission.allowed) throw new VidroomError('LOCAL_ONLY', status.admission.reason);

  const seed = request.seed ?? randomSeed();
  const fps = request.fps ?? H3_FPS;
  const graph = buildH3Prompt({
    prompt: request.prompt,
    frames: request.frames,
    width: request.width,
    height: request.height,
    seed,
  });
  const promptId = await runtime.client().queue(graph, { comment: AI_GENERATED_TAG });
  hooks.onQueued?.(promptId);
  const done = await runtime.client().waitForCompletion(promptId);
  if (done.status === 'error') {
    throw new VidroomError('RENDER_FAILED', `H3 跑失败(prompt_id=${promptId}):${done.error ?? '没给原因'}`);
  }
  const media = done.media.map((ref) => ({
    ...ref,
    url: runtime.client().viewUrl(ref),
    kind: mediaKind(ref.filename),
  }));
  const first = media[0];
  if (first === undefined) {
    throw new VidroomError('RENDER_FAILED', `H3 说跑完了,但没有产物(prompt_id=${promptId})`);
  }
  return {
    jobId: promptId,
    promptId,
    effectiveParams: {
      workflowId: H3_WORKFLOW_ID,
      workflowHash: h3WorkflowHash(),
      prompt: request.prompt,
      seed,
      width: request.width,
      height: request.height,
      frames: request.frames,
      fps,
      seconds: Number(secondsForFrames(request.frames).toFixed(3)),
      ...(request.outputRunId === undefined ? {} : { outputRunId: request.outputRunId }),
    },
    state: 'succeeded',
    media,
    graph,
    filename: first.filename,
    elapsedMs: done.elapsedMs,
  };
}

/** 单个任务的状态查询(不阻塞、不重投)。 */
export async function h3Job(runtime: VidroomRuntime, promptId: string): Promise<H3JobStatus> {
  const entry = await runtime.client().history(promptId);
  if (entry === undefined) {
    return {
      jobId: promptId,
      state: 'pending',
      note: '还没进历史:可能排队中或正在跑(不重投,继续等或再查)',
      media: [],
    };
  }
  const media = (entry.outputs === undefined ? [] : collectEntryMedia(entry)).map((ref) => ({
    ...ref,
    url: runtime.client().viewUrl(ref),
    kind: mediaKind(ref.filename),
  }));
  const statusStr = entry.status?.status_str;
  if (statusStr === 'error') {
    const { executionError } = await import('./comfy.js');
    return { jobId: promptId, state: 'failed', media, error: executionError(entry) ?? 'ComfyUI 报错但没给原因' };
  }
  return { jobId: promptId, state: 'succeeded', media };
}

function collectEntryMedia(entry: { outputs: Record<string, unknown> }): MediaRef[] {
  const media: MediaRef[] = [];
  for (const output of Object.values(entry.outputs)) {
    for (const key of ['videos', 'gifs', 'images', 'audio'] as const) {
      const list = (output as Record<string, MediaRef[] | undefined>)[key];
      for (const ref of list ?? []) media.push(ref);
    }
  }
  return media;
}
