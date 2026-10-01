/**
 * 云端生成的估价表。只用于「花钱前先把价钱摆给用户看」,不参与计费。
 *
 * 单价来自厂商官方定价页,2026-10-02 抓取:
 * - 生视频 通义万相 wan2.7-t2v:https://help.aliyun.com/zh/model-studio/wan2-7-t2v
 *   华北 2(北京)按秒计费:720P 0.6 元/秒、1080P 1 元/秒(免费额度 50 秒,开通后 90 天内)。
 * - 生图 火山方舟 Seedream 5.0:https://www.volcengine.com/ 上的官网页 0.22 元/张。
 *
 * 金额一律用「分」的整数,避免浮点误差。厂商调价时只改这里;
 * 促销、阶梯价、失败重试都可能让实际账单与估价不同,所以确认框里写的是「估价」。
 */
export type CloudResolution = '720p' | '1080p';

export const VIDEO_CENTS_PER_SECOND: Record<CloudResolution, number> = { '720p': 60, '1080p': 100 };
export const IMAGE_CENTS_PER_IMAGE = 22;

/** 万相 duration 只吃 2–15 的整数秒 */
export const VIDEO_MIN_SECONDS = 2;
export const VIDEO_MAX_SECONDS = 15;

export function videoCostCents(seconds: number, resolution: CloudResolution): number {
  return VIDEO_CENTS_PER_SECOND[resolution] * seconds;
}

export function imageCostCents(count: number): number {
  return IMAGE_CENTS_PER_IMAGE * count;
}

export function formatYuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

export function describeVideoPrice(seconds: number, resolution: CloudResolution): string {
  return `${seconds} 秒 ${resolution.toUpperCase()} 视频,估价 ${formatYuan(videoCostCents(seconds, resolution))}` +
    `(按 ${formatYuan(VIDEO_CENTS_PER_SECOND[resolution])}/秒)`;
}

export function describeImagePrice(count: number): string {
  return `${count} 张图片,估价 ${formatYuan(imageCostCents(count))}(按 ${formatYuan(IMAGE_CENTS_PER_IMAGE)}/张)`;
}
