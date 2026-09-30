import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 成片库:一个 JSON 文件(videos.json)+ 同目录下的 MP4。第一期单用户、几十上百条,JSON 够用;
 * 写入先写临时文件再改名,不会写一半。
 */

export interface VideoRecord {
  id: string;
  model: 'MiniMax H3';
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

  async add(record: VideoRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const all = await this.list();
    all.unshift(record);
    const tmp = `${this.index}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2));
    await rename(tmp, this.index);
  }
}
