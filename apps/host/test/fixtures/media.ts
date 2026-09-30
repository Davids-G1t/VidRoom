import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FfmpegPaths } from '../../src/ffmpeg/install.js';

/**
 * 剪辑测试的临时目录:**不用 os.tmpdir()**(开发机的 /tmp 是内存盘)。
 * 默认放 apps/host/.test-tmp(已 gitignore,在磁盘上);VIDROOM_TEST_TMP 可改。用完由各测试删掉。
 */
export function testTmpDir(prefix: string): string {
  const base = process.env.VIDROOM_TEST_TMP || fileURLToPath(new URL('../../.test-tmp', import.meta.url));
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

export interface ClipOptions {
  seconds: number;
  width?: number;
  height?: number;
  rate?: number;
  audio?: boolean;
  /** 每隔几帧一个关键帧 */
  gop?: number;
  /** 容器元数据 comment,用来核对剪辑后是否带过来 */
  comment?: string;
}

/**
 * 用 ffmpeg 自己的滤镜现做一段小测试素材(几百 KB):中灰底 + 左上角小 testsrc 块,底部四分之一是纯中灰,
 * 方便核对字幕像素;声音是 440Hz 正弦。H.264 用 libopenh264。
 */
export function makeClip(ff: FfmpegPaths, file: string, o: ClipOptions): void {
  const w = o.width ?? 320;
  const h = o.height ?? 240;
  const r = o.rate ?? 24;
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x808080:size=${w}x${h}:rate=${r}`,
    '-f', 'lavfi', '-i', `testsrc=size=${Math.round(w / 4)}x${Math.round(h / 4)}:rate=${r}`];
  if (o.audio !== false) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
  args.push('-filter_complex', '[0:v][1:v]overlay=8:8:shortest=1[v]', '-map', '[v]');
  if (o.audio !== false) args.push('-map', '2:a', '-c:a', 'aac', '-ac', '2');
  args.push('-t', String(o.seconds), '-c:v', 'libopenh264', '-b:v', '400k', '-g', String(o.gop ?? r), '-pix_fmt', 'yuv420p');
  if (o.comment) args.push('-metadata', `comment=${o.comment}`);
  args.push(file);
  execFileSync(ff.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

export function ffprobeJson(ff: FfmpegPaths, file: string): {
  format: { duration: string; tags?: Record<string, string> };
  streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>;
} {
  return JSON.parse(
    execFileSync(ff.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:format_tags:stream=codec_type,codec_name,width,height', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  );
}

/** 在 t 秒处抽一帧,取底部四分之一,转灰度原始像素;统计亮度 > 200 的像素个数(白字) */
export function brightPixelsInBottom(ff: FfmpegPaths, file: string, t: number): number {
  const raw = execFileSync(
    ff.ffmpeg,
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
      '-vf', 'crop=iw:ih/4:0:ih*3/4,format=gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  let n = 0;
  for (const b of raw) if (b > 200) n++;
  return n;
}

/** 抽一帧存成 PNG(只给开发机留验收截图用,不进仓库) */
export function snapshot(ff: FfmpegPaths, file: string, t: number, png: string): void {
  execFileSync(ff.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', png]);
}
