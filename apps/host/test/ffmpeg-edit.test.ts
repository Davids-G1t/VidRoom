import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { burnSubtitle, concatVideos, findFont, keyframesUpTo, probe, trimVideo } from '../src/ffmpeg/edit.js';
import { ensureFfmpeg, type FfmpegPaths } from '../src/ffmpeg/install.js';
import { brightPixelsInBottom, ffprobeJson, makeClip, testTmpDir } from './fixtures/media.js';

/**
 * 三个剪辑操作,用锁定的 LGPL ffmpeg 现做几秒钟、几百 KB 的测试素材跑真 ffmpeg。
 * 临时目录见 fixtures/media.ts(不用系统临时目录),跑完删掉。
 */

let ff: FfmpegPaths;
let dir: string;
let clip5: string;

beforeAll(async () => {
  ff = await ensureFfmpeg();
  dir = testTmpDir('edit-');
  clip5 = join(dir, 'clip5.mp4');
  makeClip(ff, clip5, { seconds: 5, gop: 24, comment: 'AI-generated test clip' });
}, 600_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const duration = (f: string) => Number(ffprobeJson(ff, f).format.duration);

describe('trimVideo', () => {
  it('素材每秒一个关键帧', async () => {
    expect(await keyframesUpTo(ff, clip5, 3)).toEqual(expect.arrayContaining([0, 1, 2, 3]));
  });

  it('前 2 秒:起点在关键帧,流复制,时长 2 秒,元数据带过来', async () => {
    const out = join(dir, 'trim-0-2.mp4');
    const r = await trimVideo(ff, { input: clip5, output: out, start: 0, end: 2 });
    expect(r.mode).toBe('copy');
    expect(duration(out)).toBeCloseTo(2, 1);
    expect(ffprobeJson(ff, out).format.tags?.comment).toBe('AI-generated test clip');
  });

  it('起点不在关键帧:重新编码,剪得准', async () => {
    const out = join(dir, 'trim-1.5-3.mp4');
    const r = await trimVideo(ff, { input: clip5, output: out, start: 1.5, end: 3 });
    expect(r.mode).toBe('reencode');
    expect(duration(out)).toBeCloseTo(1.5, 1);
    const streams = ffprobeJson(ff, out).streams;
    expect(streams.find((s) => s.codec_type === 'video')?.codec_name).toBe('h264');
    expect(streams.some((s) => s.codec_type === 'audio')).toBe(true);
  });

  it('终点超过总长按结尾算;起止不对报错', async () => {
    const out = join(dir, 'trim-4-99.mp4');
    await trimVideo(ff, { input: clip5, output: out, start: 4, end: 99 });
    expect(duration(out)).toBeCloseTo(1, 1);
    await expect(trimVideo(ff, { input: clip5, output: join(dir, 'bad.mp4'), start: 3, end: 2 })).rejects.toThrow(/起止时间不对/);
  });
});

describe('concatVideos', () => {
  it('编码参数一致:concat demuxer 流复制', async () => {
    const a = join(dir, 'a.mp4');
    const b = join(dir, 'b.mp4');
    makeClip(ff, a, { seconds: 1 });
    makeClip(ff, b, { seconds: 2 });
    const work = join(dir, "work it's, [x];");
    mkdirSync(work);
    const out = join(dir, 'cat-copy.mp4');
    const r = await concatVideos(ff, { inputs: [a, b, a], output: out, workDir: work });
    expect(r.mode).toBe('copy');
    expect(duration(out)).toBeCloseTo(4, 1);
  });

  it('尺寸不同、有的没声音:concat 滤镜统一规格后重新编码', async () => {
    const big = join(dir, 'big.mp4');
    const small = join(dir, 'small-mute.mp4');
    makeClip(ff, big, { seconds: 1 });
    makeClip(ff, small, { seconds: 1.5, width: 160, height: 120, rate: 30, audio: false });
    const out = join(dir, 'cat-mixed.mp4');
    const r = await concatVideos(ff, { inputs: [big, small], output: out, workDir: dir });
    expect(r.mode).toBe('reencode');
    const info = await probe(ff, out);
    expect(info.duration).toBeCloseTo(2.5, 1);
    expect([info.video?.width, info.video?.height]).toEqual([320, 240]);
    expect(info.audio).not.toBeNull();
  });

  it('少于两段报错', async () => {
    await expect(concatVideos(ff, { inputs: [clip5], output: join(dir, 'x.mp4'), workDir: dir })).rejects.toThrow(/至少要两段/);
  });
});

describe('burnSubtitle', () => {
  it('底部烧进一行字:抽帧底部出现白色像素,时长与元数据不变', async () => {
    const font = findFont();
    console.log(`[subtitle] 字体 ${font?.path ?? '(没找到)'}${font && !font.cjk ? '(无中文字形)' : ''}`);
    // 工作目录名里故意放滤镜里的特殊字符,核对路径转义
    const work = join(dir, "sub work it's, [a];b");
    mkdirSync(work);
    const out = join(dir, 'sub.mp4');
    expect(brightPixelsInBottom(ff, clip5, 1)).toBe(0);
    const r = await burnSubtitle(ff, { input: clip5, output: out, text: "你好 50% 'ok': [a], b; c\\", workDir: work, font });
    expect(r.font).toBe(font!.path);
    expect(brightPixelsInBottom(ff, out, 1)).toBeGreaterThan(50);
    expect(duration(out)).toBeCloseTo(5, 1);
    expect(ffprobeJson(ff, out).format.tags?.comment).toBe('AI-generated test clip');
  });

  it('顶部位置:底部仍然没有字', async () => {
    const out = join(dir, 'sub-top.mp4');
    await burnSubtitle(ff, { input: clip5, output: out, text: 'Hello', position: 'top', workDir: dir });
    expect(brightPixelsInBottom(ff, out, 1)).toBe(0);
  });

  it('空文字、找不到字体报错', async () => {
    await expect(burnSubtitle(ff, { input: clip5, output: join(dir, 'x.mp4'), text: '  ', workDir: dir })).rejects.toThrow(/空/);
    await expect(burnSubtitle(ff, { input: clip5, output: join(dir, 'x.mp4'), text: 'a', workDir: dir, font: null })).rejects.toThrow(/字体/);
  });
});
