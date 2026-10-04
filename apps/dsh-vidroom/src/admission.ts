/**
 * 显存准入:显存不到 24 GiB 时 H3 属于实验功能,默认不放行,要用户显式打开。
 *
 * 开关只有一处 —— 插件配置项 `allowExperimental`。
 */

export type GpuTier = 'default' | 'experimental' | 'unsupported' | 'unknown';

export interface Admission {
  allowed: boolean;
  tier: GpuTier;
  reason: string;
}

/** 显存(GiB)→ 档位。 */
export function gpuTier(vramTotalGiB: number | undefined): GpuTier {
  if (vramTotalGiB === undefined || !Number.isFinite(vramTotalGiB)) return 'unknown';
  if (vramTotalGiB >= 24) return 'default';
  if (vramTotalGiB >= 15) return 'experimental';
  return 'unsupported';
}

/** 能不能出片。`allowExperimental` 为真就放行实验档。 */
export function h3Admission(vramTotalGiB: number | undefined, allowExperimental: boolean): Admission {
  const tier = gpuTier(vramTotalGiB);
  switch (tier) {
    case 'default':
      return { allowed: true, tier, reason: `显存 ${vramTotalGiB?.toFixed(1)} GiB,MiniMax H3 默认开启。` };
    case 'experimental':
      return allowExperimental
        ? { allowed: true, tier, reason: `显存 ${vramTotalGiB?.toFixed(1)} GiB,已按实验档放行。` }
        : {
            allowed: false,
            tier,
            reason: `显存 ${vramTotalGiB?.toFixed(1)} GiB(不到 24 GiB),H3 属于实验功能、默认不放行;要试请把插件配置 allowExperimental 打开后重启。`,
          };
    case 'unsupported':
      return { allowed: false, tier, reason: `显存只有 ${vramTotalGiB?.toFixed(1)} GiB,本机跑不了 MiniMax H3。` };
    case 'unknown':
      return { allowed: true, tier, reason: '读不到显卡信息(ComfyUI 没报 device),不拦,直接试。' };
  }
}
