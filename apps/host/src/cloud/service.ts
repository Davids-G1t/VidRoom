import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { experimental_generateVideo as generateVideo, generateImage } from 'ai';
import { CLOUD_VIDEO_MODEL_LABEL, publicVideo, type PublicVideo, type VideoLibrary, type VideoRecord } from '../h3/library.js';
import {
  CLOUD_PROVIDERS,
  cloudBaseUrl,
  createCloudImageModel,
  createCloudVideoModel,
  loadCloudKey,
  type CloudKind,
} from './providers.js';
import {
  VIDEO_MAX_SECONDS,
  VIDEO_MIN_SECONDS,
  describeImagePrice,
  describeVideoPrice,
  imageCostCents,
  videoCostCents,
  type CloudResolution,
} from './pricing.js';

/**
 * 云端生成服务(BYOK)。
 *
 * 关键规矩:**花钱的请求只从 generate* 发出去**。
 * 聊天里的工具只调 estimate*(算个价、把参数原样带回去),用户在估价卡上点「确认」时前端才调
 * /api/cloud/generate。这样模型(LLM)自己永远花不了钱,「取消」就等于什么都没发生。
 */
export interface CloudVideoInput {
  prompt: string;
  seconds?: number;
  resolution?: CloudResolution;
}

export interface CloudImageInput {
  prompt: string;
  count?: number;
}

export interface CloudEstimate {
  kind: CloudKind;
  provider: string;
  model: string;
  /** 估价,单位「分」 */
  estimateCents: number;
  /** 给用户看的一行价钱 */
  estimateText: string;
  /** 原样回给确认方:确认时用同一份参数发起(带 kind,前端就是把它原样 POST 回 /api/cloud/generate) */
  request: ({ kind: 'video' } & CloudVideoInput) | ({ kind: 'image' } & CloudImageInput);
}

export type CloudResult =
  | { ok: true; kind: 'video'; video: PublicVideo }
  | { ok: true; kind: 'image'; image: { id: string; file: string } }
  | { ok: false; reason: string };

export interface CloudStatus {
  providers: Array<{ kind: CloudKind; label: string; model: string; configured: boolean; consoleUrl: string; keyHint: string }>;
  /** 单价表,给设置页和估价卡显示 */
  prices: { videoCentsPerSecond: Record<CloudResolution, number>; imageCentsPerImage: number };
}

export interface CloudServiceOptions {
  /** 数据目录;图片落在 <dataDir>/images 下 */
  dataDir: string;
  library: VideoLibrary;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export class CloudService {
  /** 只留在内存:桌面壳经 IPC 给,或命令行从文件读 */
  private keys: Record<CloudKind, string | null>;

  constructor(private readonly o: CloudServiceOptions) {
    this.keys = {
      video: loadCloudKey('video', o.env),
      image: loadCloudKey('image', o.env),
    };
  }

  setKeys(keys: Partial<Record<CloudKind, string | null>>): void {
    for (const kind of ['video', 'image'] as const) {
      if (kind in keys) this.keys[kind] = keys[kind] ?? null;
    }
  }

  /** 已配置的 key(给 server 当「要抹掉的秘密」用) */
  configuredKeys(): string[] {
    return (['video', 'image'] as const).map((k) => this.keys[k]).filter((k): k is string => k !== null);
  }

  /** 生图成果的绝对路径;id 不合法(带路径分隔符之类)返回 null */
  imagePath(id: string): string | null {
    return /^[\w-]+$/.test(id) ? join(this.o.dataDir, 'images', `${id}.png`) : null;
  }

  status(): CloudStatus {
    return {
      providers: (['video', 'image'] as const).map((kind) => ({
        kind,
        label: CLOUD_PROVIDERS[kind].label,
        model: CLOUD_PROVIDERS[kind].model,
        configured: this.keys[kind] !== null,
        consoleUrl: CLOUD_PROVIDERS[kind].consoleUrl,
        keyHint: CLOUD_PROVIDERS[kind].keyHint,
      })),
      prices: { videoCentsPerSecond: { '720p': 60, '1080p': 100 }, imageCentsPerImage: 22 },
    };
  }

  /** 估价:不发任何网络请求 */
  estimateVideo(input: CloudVideoInput): CloudEstimate {
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) throw new Error('要给出提示词(prompt)。');
    const seconds = input.seconds ?? 5;
    if (!Number.isInteger(seconds) || seconds < VIDEO_MIN_SECONDS || seconds > VIDEO_MAX_SECONDS) {
      throw new Error(`时长必须是 ${VIDEO_MIN_SECONDS}–${VIDEO_MAX_SECONDS} 之间的整数秒。`);
    }
    const resolution = input.resolution ?? '720p';
    if (resolution !== '720p' && resolution !== '1080p') throw new Error('分辨率只支持 720p 或 1080p。');
    const request = { kind: 'video' as const, prompt, seconds, resolution };
    return {
      kind: 'video',
      provider: CLOUD_PROVIDERS.video.label,
      model: CLOUD_PROVIDERS.video.model,
      estimateCents: videoCostCents(seconds, resolution),
      estimateText: describeVideoPrice(seconds, resolution),
      request,
    };
  }

  estimateImage(input: CloudImageInput): CloudEstimate {
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) throw new Error('要给出提示词(prompt)。');
    const count = input.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('张数只能是 1–4 的整数。');
    const request = { kind: 'image' as const, prompt, count };
    return {
      kind: 'image',
      provider: CLOUD_PROVIDERS.image.label,
      model: CLOUD_PROVIDERS.image.model,
      estimateCents: imageCostCents(count),
      estimateText: describeImagePrice(count),
      request,
    };
  }

  async generateVideo(input: CloudVideoInput): Promise<CloudResult> {
    const est = this.estimateVideo(input);
    const { prompt, seconds = 5, resolution = '720p' } = est.request as CloudVideoInput;
    const key = this.keys.video;
    if (key === null) return { ok: false, reason: `还没配置${CLOUD_PROVIDERS.video.label}的 API key,去设置里填。` };
    const startedAt = Date.now();
    try {
      const result = await generateVideo({
        model: createCloudVideoModel(key, cloudBaseUrl('video', this.o.env)),
        prompt: prompt,
        duration: seconds,
        resolution: resolution === '1080p' ? '1920x1080' : '1280x720',
        // 万相的视频接口是异步的:SDK 建任务后自己轮询,2 秒问一次(默认 5 秒);
        // 下载用 SDK 自带的(带 2 GiB 上限),结果里直接拿到字节,不用再取一次 URL
        poll: { intervalMs: 2000 },
      });
      const file = result.videos[0];
      if (!file) return { ok: false, reason: '云端没有返回视频。' };
      const id = newId();
      await mkdir(this.o.library.dir, { recursive: true });
      await writeFile(this.o.library.fileFor(id), file.uint8Array);
      const fps = Number((result.providerMetadata?.alibaba as { usage?: { fps?: number } } | undefined)?.usage?.fps);
      const record: VideoRecord = {
        id,
        model: CLOUD_VIDEO_MODEL_LABEL,
        prompt,
        frames: Number.isFinite(fps) && fps > 0 ? Math.round(seconds * fps) : 0,
        seconds,
        seed: 0,
        createdAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        peakVramMiB: null,
        peakRamMiB: null,
        metricsSimulated: false,
        file: this.o.library.fileFor(id),
      };
      await this.o.library.add(record);
      this.o.log?.(`[cloud] 视频 ${id} 完成(${seconds} 秒,${resolution},估价 ${est.estimateText})`);
      return { ok: true, kind: 'video', video: publicVideo(record) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.o.log?.(`[cloud] 视频生成失败:${reason}`);
      return { ok: false, reason: `云端生成失败:${reason}` };
    }
  }

  async generateImage(input: CloudImageInput): Promise<CloudResult> {
    const est = this.estimateImage(input);
    const { prompt, count = 1 } = est.request as CloudImageInput;
    const key = this.keys.image;
    if (key === null) return { ok: false, reason: `还没配置${CLOUD_PROVIDERS.image.label}的 API key,去设置里填。` };
    try {
      const result = await generateImage({
        model: createCloudImageModel(key, cloudBaseUrl('image', this.o.env)),
        prompt: prompt,
        n: count,
        // 方舟默认给图片加水印,显式关掉
        providerOptions: { bytedance: { watermark: false } },
      });
      const first = result.images[0];
      if (!first) return { ok: false, reason: '云端没有返回图片。' };
      const id = newId();
      const dir = join(this.o.dataDir, 'images');
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${id}.png`);
      await writeFile(file, first.uint8Array);
      this.o.log?.(`[cloud] 图片 ${id} 完成(${count} 张,估价 ${est.estimateText})`);
      return { ok: true, kind: 'image', image: { id, file } };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.o.log?.(`[cloud] 生图失败:${reason}`);
      return { ok: false, reason: `云端生图失败:${reason}` };
    }
  }
}

/** 与作品库其它地方同款 id:时间戳(秒级)+ 随机后缀 */
function newId(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${randomUUID().slice(0, 8)}`;
}
