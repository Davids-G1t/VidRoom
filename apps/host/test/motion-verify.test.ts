import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFfmpeg, type FfmpegPaths } from '../src/ffmpeg/install.js';
import { freezeCheck, longestIdenticalRun, parseFrameMd5, verifyVideo } from '../src/motion/verify.js';
import { makeClip, testTmpDir } from './fixtures/media.js';

/**
 * 交付前自检:用锁定的 LGPL ffmpeg 现做几秒、几百 KB 的小素材,真跑 framemd5 / 联系表 / ffprobe。
 * 临时目录不用系统临时目录(见 fixtures/media.ts),跑完删掉。
 */

let ff: FfmpegPaths;
let dir: string;
let moving: string;
let frozen: string;

beforeAll(async () => {
  ff = await ensureFfmpeg();
  dir = testTmpDir('motion-verify-');
  // 会动的:左上角 testsrc 每帧都在变
  moving = join(dir, 'moving.mp4');
  makeClip(ff, moving, { seconds: 3, rate: 30, audio: false });
  // 冻住的:中间 2 秒纯色一动不动
  frozen = join(dir, 'frozen.mp4');
  execFileSync(ff.ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=0.5',
    '-f', 'lavfi', '-i', 'color=c=0x336699:size=320x240:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=0.5',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1[v]', '-map', '[v]',
    '-c:v', 'libopenh264', '-b:v', '400k', '-pix_fmt', 'yuv420p', frozen,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}, 600_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('framemd5 解析与最长相同段', () => {
  it('跳过注释行,取第 6 列', () => {
    const text = '#format: frame checksums\n#stream#, dts, pts, duration, size, hash\n0, 0, 0, 1, 230400, aaa\n0, 1, 1, 1, 230400, bbb\n';
    expect(parseFrameMd5(text)).toEqual(['aaa', 'bbb']);
  });

  it('找最长的连续相同段', () => {
    expect(longestIdenticalRun([])).toEqual({ length: 0, start: 0 });
    expect(longestIdenticalRun(['a', 'b', 'c'])).toEqual({ length: 1, start: 0 });
    expect(longestIdenticalRun(['a', 'b', 'b', 'b', 'c', 'c'])).toEqual({ length: 3, start: 1 });
    expect(longestIdenticalRun(['x', 'y', 'y', 'y', 'y'])).toEqual({ length: 4, start: 1 });
  });
});

describe('冻帧检测', () => {
  it('会动的片子:没有相邻两帧完全相同', async () => {
    const r = await freezeCheck(ff, moving, 30);
    expect(r.frames).toBe(90);
    expect(r.longestRun).toBe(1);
  });

  it('中间冻住 2 秒:报出约 60 帧的相同段,从第 15 帧附近开始', async () => {
    const r = await freezeCheck(ff, frozen, 30);
    expect(r.longestRun).toBeGreaterThanOrEqual(55);
    expect(r.runStart).toBeGreaterThanOrEqual(14);
    expect(r.runStart).toBeLessThanOrEqual(17);
    expect(r.longestRunSeconds).toBeGreaterThan(1.8);
  });
});

describe('verifyVideo', () => {
  it('合格:时长对、h264、没冻帧;联系表是 4×3 拼好的 PNG', async () => {
    const sheet = join(dir, 'moving.contact.png');
    const r = await verifyVideo(ff, moving, { seconds: 3, fps: 30, width: 320, height: 240 }, sheet);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.video).toMatchObject({ codec: 'h264', width: 320, height: 240 });
    const png = readFileSync(sheet);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR 里的宽高:4 格 × 320 + 边距,3 格 × 240 + 边距
    expect(png.readUInt32BE(16)).toBe(4 * 320 + 3 * 4 + 2 * 4);
    expect(png.readUInt32BE(20)).toBe(3 * 240 + 2 * 4 + 2 * 4);
  });

  it('不合格:时长不对、尺寸不对、冻帧都列进 problems', async () => {
    const r = await verifyVideo(ff, frozen, { seconds: 10, fps: 30, width: 1280, height: 720 }, join(dir, 'frozen.contact.png'));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/时长 3\.00 秒,要求 10 秒/);
    expect(r.problems.join('\n')).toMatch(/尺寸是 320×240/);
    expect(r.problems.join('\n')).toMatch(/画面完全相同/);
  });
});
