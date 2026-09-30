import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { downloadVerified } from '../comfyui/download.js';
import { dataDir, extract7z, sevenZipPath } from '../comfyui/install.js';
import { FFMPEG_BUILDS, ffmpegDownloadUrl, type FfmpegBuild } from './manifest.js';

/**
 * ffmpeg 装在哪:Windows 与 Linux 一律在首次使用时按清单下载锁定的 LGPL 构建,解压到数据目录,
 * **不用系统自带的 ffmpeg**(发行版的 ffmpeg 通常是 --enable-gpl 构建,且版本随系统变,不可复现)。
 * 装好后跑一次 `ffmpeg -version`,configuration 行里有 --enable-gpl 就拒绝使用。
 */

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
  /** `ffmpeg -version` 的 configuration 行 */
  configuration: string;
}

export interface EnsureFfmpegOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** 数据目录,默认 dataDir() */
  root?: string;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
  log?: (msg: string) => void;
}

export function ffmpegBuildFor(platform: NodeJS.Platform): FfmpegBuild {
  const b = FFMPEG_BUILDS[platform];
  if (!b) throw new Error(`没有给 ${platform} 平台锁定 ffmpeg 构建(只支持 Windows 与 Linux)`);
  return b;
}

export function ffmpegLayout(root: string, build: FfmpegBuild) {
  const installDir = join(root, 'runtime', `ffmpeg-${build.version}`);
  const bin = join(installDir, build.rootDir, 'bin');
  return {
    installDir,
    marker: join(installDir, '.vidroom-installed.json'),
    archive: join(root, 'downloads', build.fileName),
    ffmpeg: join(bin, `ffmpeg${build.exe}`),
    ffprobe: join(bin, `ffprobe${build.exe}`),
  };
}

/** 从 `ffmpeg -version` 输出里取 configuration 行;带 --enable-gpl(或 --enable-nonfree)返回问题说明 */
export function licenseProblem(versionOutput: string): { configuration: string; problem: string | null } {
  const configuration = /^configuration:(.*)$/m.exec(versionOutput)?.[1]?.trim() ?? '';
  if (!configuration) return { configuration, problem: 'ffmpeg -version 里没有 configuration 行,无法确认许可证' };
  const flags = configuration.split(/\s+/);
  for (const bad of ['--enable-gpl', '--enable-nonfree']) {
    if (flags.includes(bad)) return { configuration, problem: `这份 ffmpeg 是 ${bad} 构建,VidRoom 只用 LGPL 构建` };
  }
  return { configuration, problem: null };
}

const run = promisify(execFile);

async function checkLicense(ffmpeg: string): Promise<string> {
  const { stdout } = await run(ffmpeg, ['-hide_banner', '-version'], { windowsHide: true });
  const { configuration, problem } = licenseProblem(stdout);
  if (problem) throw new Error(problem);
  return configuration;
}

const cache = new Map<string, Promise<FfmpegPaths>>();

/** 同一进程里同一数据目录只装/检查一次;失败了下次调用会重试 */
export function ensureFfmpeg(opts: EnsureFfmpegOptions = {}): Promise<FfmpegPaths> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const root = opts.root ?? dataDir(env, platform);
  let p = cache.get(root);
  if (!p) {
    p = install(root, platform, env, opts);
    cache.set(root, p);
    p.catch(() => cache.delete(root));
  }
  return p;
}

async function install(root: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, opts: EnsureFfmpegOptions): Promise<FfmpegPaths> {
  const log = opts.log ?? (() => {});
  const build = ffmpegBuildFor(platform);
  const layout = ffmpegLayout(root, build);

  if (!(await markerMatches(layout.marker, build)) || !existsSync(layout.ffmpeg) || !existsSync(layout.ffprobe)) {
    await mkdir(join(root, 'downloads'), { recursive: true });
    const url = ffmpegDownloadUrl(build, env);
    log(`[ffmpeg] 下载 ${url}`);
    await downloadVerified({
      url,
      dest: layout.archive,
      size: build.size,
      sha256: build.sha256,
      signal: opts.signal,
      log,
      tag: 'ffmpeg',
      onProgress: opts.onProgress,
    });
    const tmp = `${layout.installDir}.tmp`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    if (build.archive === 'zip') await extract7z(sevenZipPath(env), layout.archive, tmp);
    else await untarXz(layout.archive, tmp);
    await rm(layout.installDir, { recursive: true, force: true });
    await rename(tmp, layout.installDir);
    if (!existsSync(layout.ffmpeg) || !existsSync(layout.ffprobe)) throw new Error(`解压后找不到 ${layout.ffmpeg} 或 ffprobe`);
    await writeFile(layout.marker, JSON.stringify({ version: build.version, sha256: build.sha256 }));
    await rm(layout.archive, { force: true });
    log(`[ffmpeg] 已解压到 ${layout.installDir}`);
  }
  const configuration = await checkLicense(layout.ffmpeg);
  return { ffmpeg: layout.ffmpeg, ffprobe: layout.ffprobe, configuration };
}

async function markerMatches(marker: string, build: FfmpegBuild): Promise<boolean> {
  try {
    const m = JSON.parse(await readFile(marker, 'utf8')) as { version?: string; sha256?: string };
    return m.version === build.version && m.sha256 === build.sha256;
  } catch {
    return false;
  }
}

function untarXz(archive: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xJf', archive, '-C', outDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr!.on('data', (d) => (err += d));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar 解压失败(退出码 ${code}):${err.trim()}`))));
  });
}
