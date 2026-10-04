/**
 * 本地媒体底座:探测(`ffprobe`)、算 sha256、跑 `ffmpeg`。
 *
 * 第 2 批只借本机已有的 FFmpeg,不引任何模型(没有 ASR / OCR / VLM / TTS)。
 * 两个可执行文件都从插件配置读(默认就是 PATH 上的名字),缺了直接报
 * `MEDIA_TOOL_MISSING`,不去网上下载。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';
import { VidroomError } from './errors.js';

const run = promisify(execFile);

/** 有理数帧率(设计页里 fps 一律写成 `{num,den}`)。 */
export interface Fps {
  num: number;
  den: number;
}

/** 一个媒体文件的实测属性(设计页的 `probe`)。 */
export interface Probe {
  width: number;
  height: number;
  fps: Fps;
  frames: number;
  audio: boolean;
  durationSeconds?: number;
}

export interface MediaTools {
  ffmpegPath: string;
  ffprobePath: string;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

/** `30000/1001` → `{num:30000,den:1001}`;读不出来给 `{num:24,den:1}`。 */
export function parseFrameRate(raw: string | undefined): Fps {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec((raw ?? '').trim());
  if (match === null) return { num: 24, den: 1 };
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (num <= 0 || den <= 0) return { num: 24, den: 1 };
  return { num, den };
}

/** 把缺可执行文件的 ENOENT 翻成带码的错误。 */
async function exec(tool: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await run(tool, args, { maxBuffer: 64 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === 'ENOENT') {
      throw new VidroomError('MEDIA_TOOL_MISSING', `找不到 ${tool};本机要先有 FFmpeg(不自动下载)`);
    }
    throw new VidroomError('RENDER_FAILED', `${tool} 跑失败:${(failure.stderr ?? failure.message).slice(-1200)}`);
  }
}

/** 探测一个本地媒体文件。非媒体、读不出来直接抛错。
 *
 * 独立录音(wav/m4a)本来就没有画面,所以 `requireVideo: false` 时纯音频也算探测成功
 * —— 这时 `width/height/frames` 一律 0(帧数概念对音轨不适用)。默认仍然要求有视频轨。
 */
export async function probeMedia(
  file: string,
  tools: MediaTools,
  options: { requireVideo?: boolean } = {},
): Promise<Probe> {
  const { stdout } = await exec(tools.ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const hasAudio = (parsed.streams ?? []).some((stream) => stream.codec_type === 'audio');
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (video === undefined) {
    if (options.requireVideo !== false) {
      throw new VidroomError('PROJECT_INVALID', `${file} 里没有视频轨(本批的参考片与候选都要有画面)`);
    }
    if (!hasAudio) {
      throw new VidroomError('PROJECT_INVALID', `${file} 里既没有画面也没有音轨,当不了素材`);
    }
    const audioSeconds = Number(parsed.format?.duration ?? '');
    return {
      width: 0,
      height: 0,
      fps: { num: 24, den: 1 },
      frames: 0,
      audio: true,
      ...(Number.isFinite(audioSeconds) ? { durationSeconds: audioSeconds } : {}),
    };
  }
  const fps = parseFrameRate(video.r_frame_rate ?? video.avg_frame_rate);
  const duration = Number(video.duration ?? parsed.format?.duration ?? '');
  const nbFrames = Number(video.nb_frames ?? '');
  const frames =
    Number.isFinite(nbFrames) && nbFrames > 0
      ? Math.round(nbFrames)
      : Number.isFinite(duration)
        ? Math.round((duration * fps.num) / fps.den)
        : 0;
  if (frames <= 0) {
    throw new VidroomError('PROJECT_INVALID', `${file} 读不出帧数(ffprobe 没给 nb_frames 也读不出时长)`);
  }
  return {
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps,
    frames,
    audio: hasAudio,
    ...(Number.isFinite(duration) ? { durationSeconds: duration } : {}),
  };
}

/** 文件的 sha256(流式读,大文件不吃内存)。 */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

/** 跑一次 ffmpeg;参数是数组,不过 shell。 */
export async function runFfmpeg(args: string[], tools: MediaTools): Promise<string> {
  const { stderr } = await exec(tools.ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args]);
  return stderr;
}

/** 探一次版本(锁环境用;读不出来返回 undefined,不编)。 */
export async function toolVersion(tool: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run(tool, args, { maxBuffer: 1024 * 1024 });
    return stdout.split('\n')[0]?.trim();
  } catch {
    return undefined;
  }
}
