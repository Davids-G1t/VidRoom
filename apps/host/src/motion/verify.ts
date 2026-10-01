import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { probe } from '../ffmpeg/edit.js';
import type { FfmpegPaths } from '../ffmpeg/install.js';

/**
 * 交付前自检(借 iart-ai/motion-skills 的 tools/verify 思路,代码是自己写的),三项:
 * - MP4 探测:ffprobe 看有没有视频流、是不是 H.264、尺寸对不对、时长和要求差多少;
 * - 冻帧检测:把每一帧解码后算 md5(ffmpeg 的 framemd5 输出),找最长的一段「连续完全相同的帧」;
 *   代码渲染的每种风格都有贯穿全片的持续运动,超过 1 秒一动不动就说明 seek 没生效、渲染卡住了;
 * - 联系表:均匀抽 12 帧缩小拼成 4×3 一张 PNG,人扫一眼就知道画面对不对。
 * 都只用 VidRoom 锁定的那份 LGPL ffmpeg/ffprobe。
 */

export const FREEZE_MAX_SECONDS = 1;
export const DURATION_TOLERANCE_SECONDS = 0.1;

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (err += d));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${file.split(/[\\/]/).pop()} 失败(退出码 ${code}):${err.trim().split('\n').slice(-3).join(' | ')}`)),
    );
  });
}

export interface FreezeReport {
  frames: number;
  /** 最长一段连续完全相同的帧数(1 = 没有任何相邻两帧相同) */
  longestRun: number;
  /** 这段从第几帧开始(0 起) */
  runStart: number;
  longestRunSeconds: number;
}

/** framemd5 的输出 → 每帧的 md5 */
export function parseFrameMd5(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').map((s) => s.trim()))
    .filter((cols) => cols.length >= 6 && cols[0] === '0')
    .map((cols) => cols[5]);
}

/** 最长的连续相同段 */
export function longestIdenticalRun(hashes: string[]): { length: number; start: number } {
  let best = { length: hashes.length ? 1 : 0, start: 0 };
  let start = 0;
  for (let i = 1; i <= hashes.length; i++) {
    if (i < hashes.length && hashes[i] === hashes[start]) continue;
    if (i - start > best.length) best = { length: i - start, start };
    start = i;
  }
  return best;
}

export async function freezeCheck(ff: FfmpegPaths, file: string, fps: number): Promise<FreezeReport> {
  const out = await run(ff.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-']);
  const hashes = parseFrameMd5(out);
  const run1 = longestIdenticalRun(hashes);
  return { frames: hashes.length, longestRun: run1.length, runStart: run1.start, longestRunSeconds: Math.round((run1.length / fps) * 100) / 100 };
}

/** 均匀抽 cols×rows 帧拼成一张 PNG(每格宽 tileWidth) */
export async function contactSheet(
  ff: FfmpegPaths,
  file: string,
  output: string,
  o: { duration: number; cols?: number; rows?: number; tileWidth?: number },
): Promise<void> {
  const cols = o.cols ?? 4;
  const rows = o.rows ?? 3;
  const n = cols * rows;
  const rate = n / Math.max(o.duration, 0.1);
  const part = `${output}.part.png`;
  try {
    await run(ff.ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
      '-vf', `fps=${rate.toFixed(6)}:start_time=0,scale=${o.tileWidth ?? 320}:-2,tile=${cols}x${rows}:padding=4:margin=4`,
      '-frames:v', '1', part,
    ]);
    await rename(part, output);
  } finally {
    await rm(part, { force: true });
  }
}

export interface VerifyReport {
  ok: boolean;
  problems: string[];
  duration: number;
  video: { codec: string; width: number; height: number; frameRate: string } | null;
  freeze: FreezeReport;
  contactSheet: string;
}

/** 三项自检一起做;联系表写到 contactSheetPath。problems 为空才算通过。 */
export async function verifyVideo(
  ff: FfmpegPaths,
  file: string,
  expect: { seconds: number; fps: number; width?: number; height?: number },
  contactSheetPath: string,
): Promise<VerifyReport> {
  const problems: string[] = [];
  const info = await probe(ff, file);
  if (!info.video) problems.push('没有视频流');
  else {
    if (info.video.codec !== 'h264') problems.push(`视频编码是 ${info.video.codec},应为 h264`);
    if (expect.width && (info.video.width !== expect.width || info.video.height !== expect.height)) {
      problems.push(`尺寸是 ${info.video.width}×${info.video.height},应为 ${expect.width}×${expect.height}`);
    }
  }
  if (Math.abs(info.duration - expect.seconds) > DURATION_TOLERANCE_SECONDS) {
    problems.push(`时长 ${info.duration.toFixed(2)} 秒,要求 ${expect.seconds} 秒`);
  }
  const freeze = await freezeCheck(ff, file, expect.fps);
  if (freeze.longestRunSeconds > FREEZE_MAX_SECONDS) {
    problems.push(`从第 ${freeze.runStart} 帧起连续 ${freeze.longestRun} 帧(${freeze.longestRunSeconds} 秒)画面完全相同,渲染可能卡住了`);
  }
  await contactSheet(ff, file, contactSheetPath, { duration: info.duration });
  return {
    ok: problems.length === 0,
    problems,
    duration: info.duration,
    video: info.video && { codec: info.video.codec, width: info.video.width, height: info.video.height, frameRate: info.video.frameRate },
    freeze,
    contactSheet: contactSheetPath,
  };
}
