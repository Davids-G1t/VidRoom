import { describe, expect, it } from 'vitest';
import {
  VIDEO_CENTS_PER_SECOND,
  IMAGE_CENTS_PER_IMAGE,
  describeImagePrice,
  describeVideoPrice,
  formatYuan,
  videoCostCents,
} from '../src/cloud/pricing.js';

describe('云端估价表', () => {
  it('按秒与清晰度算钱,单位是「分」的整数', () => {
    expect(videoCostCents(5, '720p')).toBe(300);
    expect(videoCostCents(5, '1080p')).toBe(500);
    expect(videoCostCents(15, '720p')).toBe(15 * VIDEO_CENTS_PER_SECOND['720p']);
    expect(Number.isInteger(videoCostCents(7, '1080p'))).toBe(true);
  });

  it('给用户看的话里带价钱,元与分换算对', () => {
    expect(formatYuan(60)).toBe('¥0.60');
    expect(formatYuan(22)).toBe('¥0.22');
    expect(describeVideoPrice(5, '720p')).toBe('5 秒 720P 视频,估价 ¥3.00(按 ¥0.60/秒)');
    expect(describeImagePrice()).toBe('1 张图片,估价 ¥0.22(按 ¥0.22/张)');
    expect(IMAGE_CENTS_PER_IMAGE).toBe(22);
  });
});
