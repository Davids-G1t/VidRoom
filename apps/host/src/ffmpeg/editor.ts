import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { VideoLibrary, VideoRecord } from '../h3/library.js';
import { burnSubtitle, concatVideos, EditError, probe, trimVideo, type SubtitlePosition } from './edit.js';
import type { FfmpegPaths } from './install.js';

/**
 * 剪辑服务:agent 工具只按成片库的 id 操作(不让模型碰任意文件路径),结果作为新的一条入库,原片不动。
 * 同一时间只跑一个剪辑(库索引是读-改-写,串起来免得互相覆盖)。
 */

export interface EditorOptions {
  library: VideoLibrary;
  ffmpeg: () => Promise<FfmpegPaths>;
  /** 临时文件目录(concat 列表、字幕文本);放数据目录下,不用系统临时目录 */
  workDir: string;
  log?: (msg: string) => void;
}

type PublicVideo = Omit<VideoRecord, 'file'>;
export type EditResult = { ok: true; video: PublicVideo; mode?: string; note: string } | { ok: false; reason: string };

export class VideoEditor {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: EditorOptions) {}

  async list(limit = 20): Promise<Array<Pick<VideoRecord, 'id' | 'seconds' | 'createdAt' | 'editedFrom'> & { prompt: string }>> {
    return (await this.o.library.list()).slice(0, limit).map((v) => ({
      id: v.id,
      seconds: v.seconds,
      createdAt: v.createdAt,
      prompt: v.prompt.length > 80 ? `${v.prompt.slice(0, 80)}…` : v.prompt,
      editedFrom: v.editedFrom,
    }));
  }

  trim(id: string, start: number, end: number): Promise<EditResult> {
    return this.edit([id], 'trim', `${start}–${end} 秒`, async (ff, [src], out) => trimVideo(ff, { input: src.file, output: out, start, end }));
  }

  concat(ids: string[]): Promise<EditResult> {
    return this.edit(ids, 'concat', `${ids.length} 段`, (ff, srcs, out, work) =>
      concatVideos(ff, { inputs: srcs.map((s) => s.file), output: out, workDir: work }),
    );
  }

  subtitle(id: string, text: string, position: SubtitlePosition = 'bottom'): Promise<EditResult> {
    return this.edit([id], 'subtitle', text, (ff, [src], out, work) =>
      burnSubtitle(ff, { input: src.file, output: out, text, position, workDir: work }),
    );
  }

  private edit(
    ids: string[],
    op: NonNullable<VideoRecord['editedFrom']>['op'],
    detail: string,
    fn: (ff: FfmpegPaths, sources: VideoRecord[], output: string, workDir: string) => Promise<{ mode?: string; note: string }>,
  ): Promise<EditResult> {
    const job = this.queue.then(() => this.run(ids, op, detail, fn));
    this.queue = job.catch(() => {});
    return job;
  }

  private async run(
    ids: string[],
    op: NonNullable<VideoRecord['editedFrom']>['op'],
    detail: string,
    fn: (ff: FfmpegPaths, sources: VideoRecord[], output: string, workDir: string) => Promise<{ mode?: string; note: string }>,
  ): Promise<EditResult> {
    const sources: VideoRecord[] = [];
    for (const id of ids) {
      const rec = await this.o.library.get(id);
      if (!rec) return { ok: false, reason: `作品库里没有 id 为 ${id} 的视频,先用 list_videos 查` };
      sources.push(rec);
    }
    const startedAt = Date.now();
    const id = `${new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${randomUUID().slice(0, 8)}`;
    const output = this.o.library.fileFor(id);
    await mkdir(this.o.workDir, { recursive: true });
    await mkdir(this.o.library.dir, { recursive: true });
    const work = await mkdtemp(join(this.o.workDir, `${op}-`));
    try {
      const ff = await this.o.ffmpeg();
      const r = await fn(ff, sources, output, work);
      if ((await stat(output)).size === 0) throw new EditError('输出是空文件');
      const info = await probe(ff, output);
      const [n, d] = (info.video?.frameRate ?? '24/1').split('/').map(Number);
      const src = sources[0];
      const record: VideoRecord = {
        id,
        model: src.model,
        prompt: src.prompt,
        frames: Math.round(info.duration * (d ? n / d : n)),
        seconds: Math.round(info.duration * 100) / 100,
        seed: src.seed,
        createdAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        peakVramMiB: null,
        peakRamMiB: null,
        metricsSimulated: sources.some((s) => s.metricsSimulated),
        file: output,
        editedFrom: { op, sources: ids, detail },
      };
      await this.o.library.add(record);
      this.o.log?.(`[edit] ${op} ${ids.join(',')} → ${id}(${record.seconds} 秒,${r.note})`);
      const { file: _f, ...pub } = record;
      return { ok: true, video: pub, mode: r.mode, note: r.note };
    } catch (err) {
      await rm(output, { force: true });
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
