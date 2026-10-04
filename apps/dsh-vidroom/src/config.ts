/**
 * dsh-vidroom 的配置。同一份 schema 供 Loader 的入口配置(cordis.yml patch)使用;
 * 插件没有自带设置页,所以字段都是启动时读一次的普通值。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { assertLoopbackUrl } from './project.js';

export const Config = z.object({
  /** ComfyUI 的 HTTP 地址。 */
  baseUrl: z.string().default('http://127.0.0.1:8188'),
  /** 一段视频的等待预算(毫秒)。H3 七秒片在 5080 上要几分钟。 */
  timeoutMs: z.number().min(30_000).max(3_600_000).default(900_000),
  /** 等产物时的轮询间隔(毫秒)。 */
  pollIntervalMs: z.number().min(200).max(10_000).default(1_000),
  /** 显存不到 24 GiB 时是否放行(老 VidRoom 叫实验档)。 */
  allowExperimental: z.boolean().default(false),
  /** 工程目录的根(每个工程一个子目录,素材与运行都留在里面)。 */
  projectsRoot: z.string().default(join(homedir(), 'VidRoom', 'projects')),
  /** 本地 FFmpeg(合成用;缺了直接报错,不自动装)。 */
  ffmpegPath: z.string().default('ffmpeg'),
  /** 本地 ffprobe(探测用)。 */
  ffprobePath: z.string().default('ffprobe'),
  /** H3 权重所在目录(只在 lock 时核对存在性/哈希,不复制不下载)。 */
  modelsRoot: z.string().default(join(homedir(), 'Apps', 'vidroom', 'models')),
  /**
   * 要不要把第 2 批的工程工具注册进聊天。**默认不开**。
   *
   * 设计页的硬边界:参考片、文案、音轨、工程内容不进云端口语 —— 聊天工具的入参与返回都会进宿主 LLM 的上下文,
   * 所以只有宿主聊天模型确实在本机跑时才准开。这个插件读不出宿主 LLM 配在哪,只能由部署的人声明。
   * 不开时工程面走面板与本地路由(`/vidroom/project` 等),活儿与工具是同一批函数。
   */
  chatTools: z.boolean().default(false),
});

export type Config = {
  /** ComfyUI 的 HTTP 地址。 */
  baseUrl: string;
  /** 一段视频的等待预算(毫秒)。 */
  timeoutMs: number;
  /** 轮询间隔(毫秒)。 */
  pollIntervalMs: number;
  /** 显存不到 24 GiB 时是否放行。 */
  allowExperimental: boolean;
  /** 工程目录的根。 */
  projectsRoot: string;
  /** 本地 FFmpeg。 */
  ffmpegPath: string;
  /** 本地 ffprobe。 */
  ffprobePath: string;
  /** H3 权重目录。 */
  modelsRoot: string;
  /** 是否把第 2 批工程工具注册进聊天(默认 false:内容不进云端对话)。 */
  chatTools: boolean;
}

/** 媒体工具的路径(合成与探测都用这一份)。 */
export function mediaTools(config: Config): { ffmpegPath: string; ffprobePath: string } {
  return { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath };
};

/** Loader 解析过的入口配置 → 插件读的对象(缺项补默认值,地址去尾斜杠)。 */
export function readConfig(raw: Partial<Record<keyof Config, unknown>> = {}): Config {
  const num = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback);
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().replace(/\/+$/, '') : fallback;
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
  const baseUrl = str(raw.baseUrl, 'http://127.0.0.1:8188');
  // R3:执行端只允回环地址。地址写错就当场拒，而不是等出片时才把请求发出去。
  assertLoopbackUrl(baseUrl, 'ComfyUI 地址');
  return {
    baseUrl,
    timeoutMs: num(raw.timeoutMs, 900_000),
    pollIntervalMs: num(raw.pollIntervalMs, 1_000),
    allowExperimental: bool(raw.allowExperimental, false),
    projectsRoot: str(raw.projectsRoot, join(homedir(), 'VidRoom', 'projects')).replace(/\/+$/, ''),
    ffmpegPath: str(raw.ffmpegPath, 'ffmpeg').replace(/\/+$/, ''),
    ffprobePath: str(raw.ffprobePath, 'ffprobe').replace(/\/+$/, ''),
    modelsRoot: str(raw.modelsRoot, join(homedir(), 'Apps', 'vidroom', 'models')).replace(/\/+$/, ''),
    chatTools: bool(raw.chatTools, false),
  };
}
