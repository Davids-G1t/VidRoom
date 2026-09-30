import type { GpuTier } from '../gpu.js';

/**
 * 按显卡档位决定能不能调 generate_video(档位见 gpu.ts):
 *   default(≥24 GiB)         默认允许
 *   experimental(15–24 GiB)  默认不允许;用户设环境变量 VIDROOM_H3_EXPERIMENTAL=1 手动打开
 *   unsupported / none         不允许
 */
export const H3_EXPERIMENTAL_ENV = 'VIDROOM_H3_EXPERIMENTAL';

export interface Admission {
  allowed: boolean;
  tier: GpuTier;
  reason: string;
}

export function h3Admission(tier: GpuTier, env: NodeJS.ProcessEnv = process.env): Admission {
  switch (tier) {
    case 'default':
      return { allowed: true, tier, reason: '显存不低于 24 GiB,MiniMax H3 默认开启。' };
    case 'experimental':
      return env[H3_EXPERIMENTAL_ENV] === '1'
        ? { allowed: true, tier, reason: `显存 15–24 GiB,已用 ${H3_EXPERIMENTAL_ENV}=1 手动打开实验档。` }
        : {
            allowed: false,
            tier,
            reason: `显存 15–24 GiB,MiniMax H3 属于实验功能、默认关闭;要试请设置环境变量 ${H3_EXPERIMENTAL_ENV}=1 后重启 VidRoom。`,
          };
    case 'unsupported':
      return { allowed: false, tier, reason: '显存低于 15 GiB,本机不能用 MiniMax H3 出片。' };
    case 'none':
      return { allowed: false, tier, reason: '没有检测到 NVIDIA 显卡,本机不能用 MiniMax H3 出片。' };
  }
}
