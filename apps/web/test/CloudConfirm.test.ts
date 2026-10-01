import { describe, expect, it } from 'vitest';
import { cloudEstimates } from '../src/CloudConfirm';

/**
 * 估价卡的数据来源。工具的产物必须带 kind:确认那一下是把它原样 POST 回 /api/cloud/generate,
 * 而 Host 的 /api/cloud/generate 只认 body 里有 kind(video/image)的请求。
 */
describe('云端估价卡', () => {
  const estimate = {
    status: 'needs_confirmation',
    estimateText: '5 秒 720P 视频,估价 ¥3.00(按 ¥0.60/秒)',
    estimateCents: 300,
    request: { kind: 'video', prompt: '一只橘猫', seconds: 5, resolution: '720p' },
  };

  it('挑出云端工具的估价,原样带上参数', () => {
    expect(cloudEstimates([{ toolName: 'cloud_generate_video', output: estimate }])).toEqual([
      { toolName: 'cloud_generate_video', estimateText: estimate.estimateText, request: estimate.request },
    ]);
  });

  it('状态不是 needs_confirmation、缺 kind、别的工具,一律不出卡', () => {
    expect(cloudEstimates(undefined)).toEqual([]);
    expect(cloudEstimates([{ toolName: 'cloud_generate_video', output: { ...estimate, status: 'error', reason: '没配 key' } }])).toEqual([]);
    expect(
      cloudEstimates([{ toolName: 'cloud_generate_video', output: { ...estimate, request: { prompt: '猫', seconds: 5, resolution: '720p' } } }]),
    ).toEqual([]);
    expect(cloudEstimates([{ toolName: 'generate_video', output: estimate }])).toEqual([]);
  });

  it('生图估价也能出卡', () => {
    const image = { ...estimate, request: { kind: 'image', prompt: '一只橘猫' } };
    expect(cloudEstimates([{ toolName: 'cloud_generate_image', output: image }])).toHaveLength(1);
  });
});
