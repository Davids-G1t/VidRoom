/** 像素预算 + 长宽比 → 宽高。 */
import { describe, expect, it } from 'vitest';
import { ASPECT_RATIOS, resolutionFor } from '../src/resolution.js';

describe('分辨率', () => {
  it('老 VidRoom 的两档尺寸原样保留', () => {
    const landscape = resolutionFor(0.4, '16:9');
    expect([landscape.width, landscape.height]).toEqual([864, 480]);
    const vertical = resolutionFor(0.4, '9:16');
    expect([vertical.width, vertical.height]).toEqual([480, 864]);
  });

  it('0.7MP 16:9 → 1152x640(任务里那一档)', () => {
    const resolution = resolutionFor(0.7, '16:9');
    expect(resolution.width).toBe(1152);
    expect(resolution.height).toBe(640);
    expect(Number(resolution.megapixels.toFixed(3))).toBe(0.703);
  });

  it('宽高永远对齐 32 的倍数', () => {
    for (const aspect of Object.keys(ASPECT_RATIOS)) {
      for (const megapixels of [0.1, 0.4, 0.7, 1, 1.5]) {
        const resolution = resolutionFor(megapixels, aspect);
        expect(resolution.width % 32, `${aspect} ${megapixels}MP 宽没对齐:${resolution.width}`).toBe(0);
        expect(resolution.height % 32, `${aspect} ${megapixels}MP 高没对齐:${resolution.height}`).toBe(0);
      }
    }
  });

  it('不认识的档位直接报错,不猜', () => {
    expect(() => resolutionFor(0.4, '17:9')).toThrow(/不认识的长宽比 17:9/);
    expect(() => resolutionFor(0, '16:9')).toThrow(/像素数必须是正数/);
    expect(() => resolutionFor(Number.NaN, '16:9')).toThrow(/像素数必须是正数/);
  });
});
