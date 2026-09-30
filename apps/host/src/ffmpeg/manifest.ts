/**
 * ffmpeg 清单:Windows / Linux 各锁一份 **LGPL** 预编译构建,写死在代码里,运行时不去远端要清单。
 *
 * 来源:BtbN/FFmpeg-Builds —— ffmpeg 官网下载页 https://ffmpeg.org/download.html 在「Linux Static Builds」
 * 与 Windows 两栏都列了它(ffmpeg 官方自己不出预编译包)。
 * 用它的月末自动构建 `autobuild-2026-08-31-13-27`:该仓每天出一版,日构建只留约两周,
 * 每月最后一版长期保留(截至 2026-10 还能看到 2024-10-31 那版),所以锁月末那版,地址不会很快失效。
 * https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-08-31-13-27
 * size 与 sha256 取自 GitHub API 的资产信息(digest 字段),下载后本机复算一致。
 *
 * 选 `lgpl-shared` 变体:
 * - lgpl:configure 带 --enable-version3、不带 --enable-gpl,显式 --disable-libx264 / --disable-libx265;
 *   H.264 编码用 libopenh264(BSD-2-Clause)。
 * - shared:ffmpeg 本体 + 动态库,压缩包比静态版小一半多(Windows 67 MB 对 147 MB)。
 *   Linux 版的 ffmpeg 可执行文件带 RPATH `$ORIGIN/../lib`,不用设 LD_LIBRARY_PATH。
 * - 版本线 n9.0.1(release/9.0 分支),不用 master 构建。
 */

export interface FfmpegBuild {
  version: string;
  releaseTag: string;
  fileName: string;
  url: string;
  size: number;
  sha256: string;
  /** 压缩包里的顶层目录 */
  rootDir: string;
  archive: 'zip' | 'tar.xz';
  /** 可执行文件扩展名 */
  exe: '' | '.exe';
}

const TAG = 'autobuild-2026-08-31-13-27';
const base = (f: string) => `https://github.com/BtbN/FFmpeg-Builds/releases/download/${TAG}/${f}`;

export const FFMPEG_BUILDS: Partial<Record<NodeJS.Platform, FfmpegBuild>> = {
  win32: {
    version: 'n9.0.1-11-ge47273f4d9',
    releaseTag: TAG,
    fileName: 'ffmpeg-n9.0.1-11-ge47273f4d9-win64-lgpl-shared-9.0.zip',
    url: base('ffmpeg-n9.0.1-11-ge47273f4d9-win64-lgpl-shared-9.0.zip'),
    size: 67_201_333,
    sha256: '83a824f0729a69d143c9865125bb86988a11dd388325f0033711045522068aa0',
    rootDir: 'ffmpeg-n9.0.1-11-ge47273f4d9-win64-lgpl-shared-9.0',
    archive: 'zip',
    exe: '.exe',
  },
  linux: {
    version: 'n9.0.1-11-ge47273f4d9',
    releaseTag: TAG,
    fileName: 'ffmpeg-n9.0.1-11-ge47273f4d9-linux64-lgpl-shared-9.0.tar.xz',
    url: base('ffmpeg-n9.0.1-11-ge47273f4d9-linux64-lgpl-shared-9.0.tar.xz'),
    size: 54_392_472,
    sha256: 'ec8dc218c3495af574be2c894de74c5f3f1f1b86cc8a95739d220b88887024fa',
    rootDir: 'ffmpeg-n9.0.1-11-ge47273f4d9-linux64-lgpl-shared-9.0',
    archive: 'tar.xz',
    exe: '',
  },
};

/** 换镜像:设了就从它给的完整地址下载;下完照样按清单 sha256 校验 */
export const FFMPEG_DOWNLOAD_URL_ENV = 'VIDROOM_FFMPEG_DOWNLOAD_URL';

export function ffmpegDownloadUrl(build: FfmpegBuild, env: NodeJS.ProcessEnv = process.env): string {
  return env[FFMPEG_DOWNLOAD_URL_ENV]?.trim() || build.url;
}
