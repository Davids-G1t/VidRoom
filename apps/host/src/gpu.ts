import { execFile } from 'node:child_process';

/**
 * 显卡探测:跑 nvidia-smi,解析型号与显存,按显存分档。
 *
 * 分档(第一期只有 MiniMax H3 一个本地模型):
 *   none         没有 NVIDIA 显卡(找不到 nvidia-smi 或执行失败)→ 不开本地视频
 *   unsupported  显存 < 15 GiB → 不开本地出片
 *   experimental 15 GiB ≤ 显存 < 24 GiB → H3 可用,默认关闭,标「实验」
 *   default      显存 ≥ 24 GiB → H3 默认开启
 *
 * nvidia-smi 的 memory.total(nounits)单位是 MiB。标称「16GB」「24GB」的卡实报
 * 会略少于 16384 / 24576 MiB(如 4060 Ti 16GB 报 16380,4090 报 24564),所以先把
 * MiB 四舍五入到整 GiB 再比阈值,否则 4090 会被误判成「实验」档。
 */

export const NVIDIA_SMI_ARGS = [
  '--query-gpu=name,memory.total',
  '--format=csv,noheader,nounits',
] as const;

export type GpuTier = 'none' | 'unsupported' | 'experimental' | 'default';

export interface GpuInfo {
  name: string;
  memoryMiB: number;
  /** 四舍五入到整 GiB,用于分档与对用户描述(如 16) */
  memoryGiB: number;
}

export interface GpuProbeResult {
  hasNvidiaGpu: boolean;
  /** 显存最大的那张卡(分档依据);没有 NVIDIA 显卡时为 null */
  primary: GpuInfo | null;
  gpus: GpuInfo[];
  tier: GpuTier;
  /** 给 agent 看的一句话解释 */
  summary: string;
  /** true = 用户在设置里选了「不用本机显卡」,tier 是被改小了,不是硬件不行 */
  forcedNoLocalGpu?: boolean;
}

export const TIER_MIN_GIB = { experimental: 15, default: 24 } as const;

export function parseNvidiaSmi(stdout: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const comma = trimmed.lastIndexOf(',');
    if (comma < 0) continue;
    const name = trimmed.slice(0, comma).trim();
    const memoryMiB = Number(trimmed.slice(comma + 1).trim());
    if (!name || !Number.isFinite(memoryMiB) || memoryMiB <= 0) continue;
    gpus.push({ name, memoryMiB, memoryGiB: Math.round(memoryMiB / 1024) });
  }
  return gpus;
}

export function classifyTier(memoryMiB: number | null): GpuTier {
  if (memoryMiB === null) return 'none';
  const gib = Math.round(memoryMiB / 1024);
  if (gib >= TIER_MIN_GIB.default) return 'default';
  if (gib >= TIER_MIN_GIB.experimental) return 'experimental';
  return 'unsupported';
}

const TIER_SUMMARY: Record<GpuTier, string> = {
  none: '没有检测到 NVIDIA 显卡,本机不能本地生成视频。',
  unsupported: '显存低于 15 GiB,本机不开放本地出片。',
  experimental: '显存在 15–24 GiB 之间,本地视频模型 MiniMax H3 可用但默认关闭,属于实验功能。',
  default: '显存不低于 24 GiB,本地视频模型 MiniMax H3 默认开启。',
};

/** 由 nvidia-smi 的输出(或 null = 命令不存在/失败)得出探测结果。纯函数,便于测试。 */
export function resultFromOutput(stdout: string | null): GpuProbeResult {
  const gpus = stdout === null ? [] : parseNvidiaSmi(stdout);
  const primary = gpus.reduce<GpuInfo | null>(
    (best, g) => (best === null || g.memoryMiB > best.memoryMiB ? g : best),
    null,
  );
  const tier = classifyTier(primary?.memoryMiB ?? null);
  return { hasNvidiaGpu: primary !== null, primary, gpus, tier, summary: TIER_SUMMARY[tier] };
}

export type RunNvidiaSmi = () => Promise<string | null>;

/** 真的去跑 nvidia-smi;命令不存在或执行失败返回 null。 */
export const runNvidiaSmi: RunNvidiaSmi = () =>
  new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      [...NVIDIA_SMI_ARGS],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });

export async function probeGpu(run: RunNvidiaSmi = runNvidiaSmi): Promise<GpuProbeResult> {
  return resultFromOutput(await run());
}

/**
 * 用户在设置里选了「不用本机显卡」时,把档位按 none 处理(硬件信息照旧如实报)。
 * 云端生成走 cloud/ 那套,不受这里影响。
 */
export function withForcedTier(result: GpuProbeResult, force: boolean): GpuProbeResult {
  if (!force || result.tier === 'none') return result;
  return {
    ...result,
    tier: 'none',
    forcedNoLocalGpu: true,
    summary: `用户选择了「不用本机显卡出片」,本地档位按 none 处理。硬件本身:${result.summary}`,
  };
}
