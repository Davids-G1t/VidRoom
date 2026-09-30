import { describe, expect, it } from 'vitest';
import { H3_MAX_FRAMES, H3_MIN_FRAMES, framesForSeconds, isValidFrameCount, snapFrames } from '../src/h3/frames.js';

describe('H3 帧数网格 17k+5', () => {
  it('时长折帧:5 秒 → 124 帧,3 秒 → 73 帧', () => {
    expect(framesForSeconds(5)).toBe(124);
    expect(framesForSeconds(3)).toBe(73);
  });

  it('合法帧数原样保留', () => {
    for (const n of [5, 22, 39, 56, 73, 90, 107, 124, 362]) {
      expect(isValidFrameCount(n)).toBe(true);
      expect(snapFrames(n)).toBe(n);
    }
  });

  it('非法帧数判不合法', () => {
    for (const n of [0, 4, 6, 72, 74, 120, 125, 363, 379, 73.5, NaN, -22]) expect(isValidFrameCount(n)).toBe(false);
  });

  it('任意帧数吸附到最近的合法值', () => {
    expect(snapFrames(120)).toBe(124); // 离 124 差 4,离 107 差 13
    expect(snapFrames(115)).toBe(107); // 离 107 差 8,离 124 差 9
    expect(snapFrames(116)).toBe(124); // 离 124 差 8,离 107 差 9
    expect(snapFrames(72)).toBe(73);
    expect(snapFrames(64)).toBe(56);
    expect(snapFrames(65)).toBe(73);
    expect(snapFrames(73.4)).toBe(73);
  });

  it('边界:小于最小值 → 5;大于上限 → 362;非有限数 → 5', () => {
    expect(snapFrames(-10)).toBe(H3_MIN_FRAMES);
    expect(snapFrames(0)).toBe(5);
    expect(snapFrames(5)).toBe(5);
    expect(snapFrames(13)).toBe(5);
    expect(snapFrames(14)).toBe(22);
    expect(snapFrames(H3_MAX_FRAMES)).toBe(362);
    expect(snapFrames(10_000)).toBe(362);
    expect(snapFrames(NaN)).toBe(5);
    expect(snapFrames(Infinity)).toBe(5);
  });

  it('1..400 的每个整数吸附结果都合法且是最近的', () => {
    const grid = Array.from({ length: 22 }, (_, k) => 17 * k + 5);
    for (let n = 1; n <= 400; n++) {
      const s = snapFrames(n);
      expect(isValidFrameCount(s)).toBe(true);
      const clamped = Math.min(Math.max(n, H3_MIN_FRAMES), H3_MAX_FRAMES);
      const best = Math.min(...grid.map((g) => Math.abs(g - clamped)));
      expect(Math.abs(s - clamped)).toBe(best);
    }
  });
});
