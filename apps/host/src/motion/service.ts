import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FfmpegPaths } from '../ffmpeg/install.js';
import { publicVideo, type PublicVideo, type VideoLibrary, type VideoRecord } from '../h3/library.js';
import { encodeFrames, hyperframesEnv, renderFrames } from './render.js';
import { STYLE_LABELS, buildComposition, planStoryboard, requestProblem, type MotionRequest, type Storyboard } from './storyboard.js';
import { verifyVideo, type VerifyReport } from './verify.js';

/**
 * 代码渲染视频服务:分镜 → 构建合成 → HyperFrames 逐帧渲染 → ffmpeg 编码 → 交付前自检 → 入库(和 H3 成片同一个作品库)。
 * 不占显卡、不用 AI 模型。同一时间只跑一个(Chrome 进程吃内存);中间文件放数据目录,不用系统临时目录。
 */

export interface MotionServiceOptions {
  library: VideoLibrary;
  ffmpeg: () => Promise<FfmpegPaths>;
  /** chrome-headless-shell 路径(首次调用时下载) */
  browser: () => Promise<string>;
  /** 中间文件(合成、逐帧 PNG、Chrome 临时目录)的根目录 */
  workDir: string;
  /** 给 HyperFrames 当家目录(它会在家目录下写 .hyperframes/) */
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export type MotionResult =
  | {
      ok: true;
      video: PublicVideo;
      storyboard: Storyboard;
      /** 自检结果(联系表路径已去掉) */
      check: Omit<VerifyReport, 'contactSheet'>;
      note: string;
    }
  | { ok: false; reason: string; check?: Omit<VerifyReport, 'contactSheet'> };

export class MotionService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: MotionServiceOptions) {}

  render(req: MotionRequest): Promise<MotionResult> {
    const job = this.queue.then(() => this.run(req));
    this.queue = job.catch(() => {});
    return job;
  }

  private async run(req: MotionRequest): Promise<MotionResult> {
    const problem = requestProblem(req);
    if (problem) return { ok: false, reason: problem };
    const log = this.o.log ?? (() => {});
    const sb = planStoryboard(req);
    const startedAt = Date.now();
    const id = `${new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${randomUUID().slice(0, 8)}`;
    const work = join(this.o.workDir, id);
    const projectDir = join(work, 'project');
    const framesDir = join(work, 'frames');
    const tmpDir = join(work, 'tmp');
    const output = this.o.library.fileFor(id);
    const sheet = this.o.library.contactSheetFor(id);
    try {
      await mkdir(projectDir, { recursive: true });
      await mkdir(tmpDir, { recursive: true });
      await mkdir(this.o.homeDir, { recursive: true });
      await mkdir(this.o.library.dir, { recursive: true });
      await writeFile(join(projectDir, 'index.html'), buildComposition(sb));
      log(`[motion] ${id} 分镜:${sb.shots.map((s) => `${s.label} ${s.start}–${s.end}s`).join(' → ')}(${STYLE_LABELS[sb.style]})`);

      const [ff, browser] = await Promise.all([this.o.ffmpeg(), this.o.browser()]);
      const env = hyperframesEnv({ base: this.o.env, browser, ff, tmpDir, homeDir: this.o.homeDir });
      const frames = await renderFrames({ projectDir, framesDir, fps: sb.fps, env });
      log(`[motion] ${id} 渲染出 ${frames} 帧`);
      await encodeFrames(ff, { framesDir, fps: sb.fps, width: sb.width, height: sb.height, output });

      const report = await verifyVideo(ff, output, { seconds: sb.seconds, fps: sb.fps, width: sb.width, height: sb.height }, sheet);
      const { contactSheet: _c, ...check } = report;
      if (!report.ok) {
        await rm(output, { force: true });
        await rm(sheet, { force: true });
        return { ok: false, reason: `交付前自检没通过:${report.problems.join(';')}`, check };
      }
      const record: VideoRecord = {
        id,
        model: 'HyperFrames',
        prompt: sb.subtitle ? `${sb.title} — ${sb.subtitle}` : sb.title,
        frames: report.freeze.frames,
        seconds: Math.round(report.duration * 100) / 100,
        seed: 0,
        createdAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        peakVramMiB: null,
        peakRamMiB: null,
        metricsSimulated: false,
        file: output,
        contactSheet: sheet,
        motion: { style: sb.style, title: sb.title, subtitle: sb.subtitle, shots: sb.shots.map(({ label, start, end }) => ({ label, start, end })) },
      };
      await this.o.library.add(record);
      log(`[motion] ${id} 入库:${record.seconds} 秒,联系表 ${sheet}`);
      return { ok: true, video: publicVideo(record), storyboard: sb, check, note: `代码渲染(HyperFrames),风格:${STYLE_LABELS[sb.style]}` };
    } catch (err) {
      await rm(output, { force: true });
      await rm(sheet, { force: true });
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
