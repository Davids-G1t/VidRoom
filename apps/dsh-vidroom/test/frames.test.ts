/** H3 的帧数网格与吸附。 */
import { describe, expect, it } from 'vitest';
import {
  H3_FPS,
  H3_MAX_FRAMES,
  framesForSeconds,
  isValidFrameCount,
  secondsForFrames,
  snapFrames,
} from '../src/frames.js';

describe('H3 帧数', () => {
  it('只认 17k+5 网格', () => {
    for (const frames of [5, 22, 124, 175, 362]) expect(isValidFrameCount(frames), `${frames} 该在网格上`).toBe(true);
    for (const frames of [4, 6, 100, 169, 363, 0, -5, 12.5])
      expect(isValidFrameCount(frames), `${frames} 不该在网格上`).toBe(false);
    expect(isValidFrameCount(H3_MAX_FRAMES)).toBe(true);
  });

  it('吸附到最近的合法帧数', () => {
    expect(snapFrames(169)).toBe(175);
    expect(snapFrames(168)).toBe(175);
    expect(snapFrames(166)).toBe(158);
    expect(snapFrames(165)).toBe(158);
    expect(snapFrames(124)).toBe(124);
    expect(snapFrames(100)).toBe(107);
    expect(snapFrames(0)).toBe(5);
    expect(snapFrames(-100)).toBe(5);
    expect(snapFrames(999)).toBe(H3_MAX_FRAMES);
    expect(snapFrames(Number.NaN)).toBe(5);
  });

  it('秒数与帧数来回换算', () => {
    expect(H3_FPS).toBe(24);
    expect(framesForSeconds(5)).toBe(124);
    expect(framesForSeconds(7)).toBe(175);
    expect(framesForSeconds(15)).toBe(362);
    expect(framesForSeconds(0.2)).toBe(5);
    expect(secondsForFrames(124)).toBe(124 / H3_FPS);
    expect(Number(secondsForFrames(framesForSeconds(7)).toFixed(2))).toBe(7.29);
  });
});
