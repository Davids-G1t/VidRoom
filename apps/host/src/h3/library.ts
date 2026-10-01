import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 成片库:一个 JSON 文件(videos.json)+ 同目录下的 MP4。第一期单用户、几十上百条,JSON 够用;
 * 写入先写临时文件再改名,不会写一半。
 */

/** 云端出片(阿里云百炼通义万相)的署名;写进记录里,作品库据此认它不是本机模型出的 */
export const CLOUD_VIDEO_MODEL_LABEL = '通义万相 wan2.7-t2v';

export interface VideoRecord {
  id: string;
  /**
   * 'HyperFrames' = 代码渲染(没有用 AI 模型),它的 seed 为 0、显存/内存峰值为 null;
   * '通义万相 wan2.7-t2v' = 云端生成(不占本机显卡),显存/内存峰值同为 null
   */
  model: 'MiniMax H3' | 'HyperFrames' | typeof CLOUD_VIDEO_MODEL_LABEL;
  prompt: string;
  frames: number;
  seconds: number;
  seed: number;
  /** 生成完成时间,ISO 8601 */
  createdAt: string;
  /** 从提交到拿到成片的耗时 */
  elapsedMs: number;
  /** 出片期间 ComfyUI 报告的显存占用峰值(所有设备里最大的一块) */
  peakVramMiB: number | null;
  /** 出片期间 ComfyUI 报告的系统内存占用峰值(整机,不只是 ComfyUI 进程) */
  peakRamMiB: number | null;
  /** true = 指标是假 ComfyUI 回放编的模拟值,不是真实测量 */
  metricsSimulated: boolean;
  /** MP4 的绝对路径 */
  file: string;
  /** 剪辑产物才有:由哪几条(按顺序)经什么操作得到;prompt/seed 沿用第一条来源 */
  editedFrom?: { op: 'trim' | 'concat' | 'subtitle'; sources: string[]; detail: string };
  /** 代码渲染产物才有:交付前自检生成的联系表 PNG(绝对路径,和 MP4 放在同一目录) */
  contactSheet?: string;
  /** 代码渲染产物才有:风格包与分镜 */
  motion?: { style: string; title: string; subtitle: string | null; shots: Array<{ label: string; start: number; end: number }> };
}

/** 给页面和 agent 看的记录:去掉本机绝对路径 */
export type PublicVideo = Omit<VideoRecord, 'file' | 'contactSheet'>;

export function publicVideo(rec: VideoRecord): PublicVideo {
  const { file: _f, contactSheet: _c, ...pub } = rec;
  return pub;
}

export class VideoLibrary {
  readonly index: string;

  constructor(readonly dir: string) {
    this.index = join(dir, 'videos.json');
  }

  async list(): Promise<VideoRecord[]> {
    try {
      return JSON.parse(await readFile(this.index, 'utf8')) as VideoRecord[];
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<VideoRecord | null> {
    return (await this.list()).find((v) => v.id === id) ?? null;
  }

  fileFor(id: string): string {
    return join(this.dir, `${id}.mp4`);
  }

  contactSheetFor(id: string): string {
    return join(this.dir, `${id}.contact.png`);
  }

  async add(record: VideoRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const all = await this.list();
    all.unshift(record);
    const tmp = `${this.index}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2));
    await rename(tmp, this.index);
  }
}
