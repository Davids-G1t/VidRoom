/**
 * 版本门槛:
 * - ComfyUI ≥ 0.30.0(MiniMax H3 官方文档写的最低版本);
 * - PyTorch 的 CUDA 版本 ≥ 13.0(H3 的 int8_convrot 权重要求;低了不是跑不起来,而是出纯噪声)。
 * 数据来自 ComfyUI 的 /system_stats:system.comfyui_version、system.pytorch_version(形如 "2.14.0+cu130")。
 */

export const MIN_COMFYUI_VERSION = '0.30.0';
export const MIN_TORCH_CUDA = '13.0';

export interface SystemStats {
  system: { comfyui_version?: string; pytorch_version?: string; [k: string]: unknown };
  devices: Array<{ name: string; type: string; [k: string]: unknown }>;
}

export interface VersionCheck {
  comfyuiVersion: string | null;
  pytorchVersion: string | null;
  /** 从 pytorch_version 的 +cuXYZ 后缀读出的 CUDA 版本(如 "13.0");CPU 版 PyTorch 为 null */
  torchCuda: string | null;
  ok: boolean;
  problems: string[];
}

/** 按点分数字比较;a < b 返回负数 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** "2.14.0+cu130" → "13.0";"2.8.0+cu126" → "12.6";torch.version.cuda 本身("13.0")原样返回 */
export function cudaFromTorchVersion(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /\+cu(\d+)(\d)$/.exec(v.trim());
  if (m) return `${m[1]}.${m[2]}`;
  return /^\d+\.\d+$/.test(v.trim()) ? v.trim() : null;
}

export function checkVersions(stats: SystemStats): VersionCheck {
  const comfyuiVersion = stats.system.comfyui_version ?? null;
  const pytorchVersion = stats.system.pytorch_version ?? null;
  const torchCuda = cudaFromTorchVersion(pytorchVersion);
  const problems: string[] = [];
  if (!comfyuiVersion || compareVersions(comfyuiVersion, MIN_COMFYUI_VERSION) < 0) {
    problems.push(`ComfyUI 版本 ${comfyuiVersion ?? '未知'} 低于 ${MIN_COMFYUI_VERSION}`);
  }
  if (!torchCuda || compareVersions(torchCuda, MIN_TORCH_CUDA) < 0) {
    problems.push(`PyTorch ${pytorchVersion ?? '未知'} 的 CUDA 版本 ${torchCuda ?? '无'} 低于 ${MIN_TORCH_CUDA}`);
  }
  return { comfyuiVersion, pytorchVersion, torchCuda, ok: problems.length === 0, problems };
}
