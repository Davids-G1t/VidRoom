/**
 * 显存准入:老 VidRoom 的规矩 —— 显存不到 24 GiB 时 H3 属于实验功能,
 * 默认不放行,要用户显式打开。
 *
 * 插件把「显存」这一个判据留在代码里,开关挪到配置项 `allowExperimental`
 * (环境变量 `VIDROOM_H3_EXPERIMENTAL=1` 仍然认,便于无人值守的老脚本)。
 */

/** 老脚本用的环境变量,继续认。 */
export const H3_EXPERIMENTAL_ENV = 'VIDROOM_H3_EXPERIMENTAL';

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

/** 能不能出片。`allowExperimental` 为真或环境变量开了就放行实验档。 */
export function h3Admission(
  vramTotalGiB: number | undefined,
  allowExperimental: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Admission {
  const tier = gpuTier(vramTotalGiB);
  const experimentalOpen = allowExperimental || env[H3_EXPERIMENTAL_ENV] === '1';
  switch (tier) {
    case 'default':
      return { allowed: true, tier, reason: `显存 ${vramTotalGiB?.toFixed(1)} GiB,MiniMax H3 默认开启。` };
    case 'experimental':
      return experimentalOpen
        ? { allowed: true, tier, reason: `显存 ${vramTotalGiB?.toFixed(1)} GiB,已按实验档放行。` }
        : {
            allowed: false,
            tier,
            reason: `显存 ${vramTotalGiB?.toFixed(1)} GiB(不到 24 GiB),H3 属于实验功能、默认不放行;要试请把插件配置 allowExperimental 打开(或设 ${H3_EXPERIMENTAL_ENV}=1)后重启。`,
          };
    case 'unsupported':
      return { allowed: false, tier, reason: `显存只有 ${vramTotalGiB?.toFixed(1)} GiB,本机跑不了 MiniMax H3。` };
    case 'unknown':
      return { allowed: true, tier, reason: '读不到显卡信息(ComfyUI 没报 device),不拦,直接试。' };
  }
}
