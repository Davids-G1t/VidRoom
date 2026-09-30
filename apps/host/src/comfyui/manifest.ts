/**
 * ComfyUI 便携包清单(只在 Windows 上用;Linux 复用已装好的 ComfyUI,见 install.ts)。
 *
 * 写死在代码里,运行时不去远端要清单。数值取自官方 Release 页面
 * https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.38.0 的资产信息(GitHub API 的 digest 字段):
 * tag v0.38.0 → commit 6b747c0428c343e1417219641db93a4fb7cb69ae。
 *
 * 选 `ComfyUI_windows_portable_nvidia.7z`(官方 NVIDIA 便携包,自带 Python + CUDA 版 PyTorch);
 * 同一 Release 里另有 `_nvidia_cu126`(老驱动用)、`_amd`、`_intel`,第一期不用。
 */
export const COMFYUI_PORTABLE = {
  version: '0.38.0',
  commit: '6b747c0428c343e1417219641db93a4fb7cb69ae',
  fileName: 'ComfyUI_windows_portable_nvidia.7z',
  url: 'https://github.com/Comfy-Org/ComfyUI/releases/download/v0.38.0/ComfyUI_windows_portable_nvidia.7z',
  size: 1_994_326_521,
  sha256: '8f137eac345707fd7e42bcf8e29377415243011ca15522a86aed6c77331fbd56',
  /** 压缩包里的顶层目录 */
  rootDir: 'ComfyUI_windows_portable',
} as const;

/**
 * 换镜像:设了这个环境变量就从它给的完整地址下载,不用清单里的 GitHub 地址。
 * 镜像内容不可信也无妨 —— 下完照样按清单里的 sha256 校验,对不上不用。
 */
export const DOWNLOAD_URL_ENV = 'VIDROOM_COMFYUI_DOWNLOAD_URL';

export function portableDownloadUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env[DOWNLOAD_URL_ENV]?.trim() || COMFYUI_PORTABLE.url;
}
