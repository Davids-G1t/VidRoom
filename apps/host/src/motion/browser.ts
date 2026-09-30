import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadVerified } from '../comfyui/download.js';
import { dataDir, extract7z, sevenZipPath } from '../comfyui/install.js';

/**
 * 代码渲染用的浏览器:Chrome for Testing 的 chrome-headless-shell(Google 构建,来自 Chromium 开源项目)。
 *
 * 为什么是它、为什么不复用 Electron 自带的 Chromium,见 docs/third-party.md「浏览器」一节。要点:
 * - HyperFrames 自己锁的就是这一版(hyperframes@0.8.98 的 packages/cli/src/browser/manager.ts:
 *   CHROME_VERSION = "152.0.7977.30"),它默认用 @puppeteer/browsers 下到 ~/.cache/hyperframes/chrome,
 *   **不校验 sha256**。VidRoom 不走它的下载:自己按下面的清单下、校验 sha256、解压到数据目录,
 *   再用 HYPERFRAMES_BROWSER_PATH 指给它(这个环境变量在它的解析顺序里优先于缓存与自动下载)。
 * - 地址是 Chrome for Testing 的公开存储桶(@puppeteer/browsers 默认下的也是这里);
 *   size 与 sha256 为 2026-10-01 下载后本机计算,md5 与存储桶 x-goog-hash 头一致。
 */

export interface BrowserBuild {
  version: string;
  fileName: string;
  url: string;
  size: number;
  sha256: string;
  /** 压缩包里的顶层目录 */
  rootDir: string;
  exe: string;
}

export const HEADLESS_SHELL_VERSION = '152.0.7977.30';
const base = (platform: string, f: string) =>
  `https://storage.googleapis.com/chrome-for-testing-public/${HEADLESS_SHELL_VERSION}/${platform}/${f}`;

export const BROWSER_BUILDS: Partial<Record<NodeJS.Platform, BrowserBuild>> = {
  win32: {
    version: HEADLESS_SHELL_VERSION,
    fileName: 'chrome-headless-shell-win64.zip',
    url: base('win64', 'chrome-headless-shell-win64.zip'),
    size: 119_527_247,
    sha256: '5d7df999a6e4a65a1b16b25b61064f7337b8aa8ee2ed1b4e07bfdd24f6e4275e',
    rootDir: 'chrome-headless-shell-win64',
    exe: 'chrome-headless-shell.exe',
  },
  linux: {
    version: HEADLESS_SHELL_VERSION,
    fileName: 'chrome-headless-shell-linux64.zip',
    url: base('linux64', 'chrome-headless-shell-linux64.zip'),
    size: 119_388_396,
    sha256: '1b150320178ecabe39726bcf3198ebb896ba2b7a07d870db1710914c42d55221',
    rootDir: 'chrome-headless-shell-linux64',
    exe: 'chrome-headless-shell',
  },
};

/** 换镜像:设了就从它给的完整地址下载;下完照样按清单 sha256 校验 */
export const BROWSER_DOWNLOAD_URL_ENV = 'VIDROOM_BROWSER_DOWNLOAD_URL';

export function browserBuildFor(platform: NodeJS.Platform): BrowserBuild {
  const b = BROWSER_BUILDS[platform];
  if (!b) throw new Error(`没有给 ${platform} 平台锁定 chrome-headless-shell(只支持 Windows 与 Linux)`);
  return b;
}

export function browserLayout(root: string, build: BrowserBuild) {
  const installDir = join(root, 'runtime', `chrome-headless-shell-${build.version}`);
  return {
    installDir,
    marker: join(installDir, '.vidroom-installed.json'),
    archive: join(root, 'downloads', build.fileName),
    exe: join(installDir, build.rootDir, build.exe),
  };
}

export interface EnsureBrowserOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  root?: string;
  /** 测试用:换掉清单(假镜像上的小文件) */
  build?: BrowserBuild;
  onProgress?: (received: number, total: number) => void;
  log?: (msg: string) => void;
}

const cache = new Map<string, Promise<string>>();

/** 返回 chrome-headless-shell 可执行文件路径;没装就按清单下载、校验、解压。同一数据目录进程内只做一次。 */
export function ensureBrowser(opts: EnsureBrowserOptions = {}): Promise<string> {
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

async function install(root: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, opts: EnsureBrowserOptions): Promise<string> {
  const log = opts.log ?? (() => {});
  const build = opts.build ?? browserBuildFor(platform);
  const layout = browserLayout(root, build);
  if ((await markerMatches(layout.marker, build)) && existsSync(layout.exe)) return layout.exe;

  await mkdir(join(root, 'downloads'), { recursive: true });
  const url = env[BROWSER_DOWNLOAD_URL_ENV]?.trim() || build.url;
  log(`[browser] 下载 ${url}`);
  await downloadVerified({ url, dest: layout.archive, size: build.size, sha256: build.sha256, log, tag: 'browser', onProgress: opts.onProgress });
  const tmp = `${layout.installDir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  // Windows 用随安装包带的 7za;Linux 上 npm 包里的 7za 没有可执行位,用系统 unzip(保留可执行位)
  if (platform === 'win32') await extract7z(sevenZipPath(env), layout.archive, tmp);
  else await unzip(layout.archive, tmp);
  await rm(layout.installDir, { recursive: true, force: true });
  await rename(tmp, layout.installDir);
  if (!existsSync(layout.exe)) throw new Error(`解压后找不到 ${layout.exe}`);
  await writeFile(layout.marker, JSON.stringify({ version: build.version, sha256: build.sha256 }));
  await rm(layout.archive, { force: true });
  log(`[browser] 已解压到 ${layout.installDir}`);
  return layout.exe;
}

async function markerMatches(marker: string, build: BrowserBuild): Promise<boolean> {
  try {
    const m = JSON.parse(await readFile(marker, 'utf8')) as { version?: string; sha256?: string };
    return m.version === build.version && m.sha256 === build.sha256;
  } catch {
    return false;
  }
}

function unzip(archive: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-q', '-o', archive, '-d', outDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr!.on('data', (d) => (err += d));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`unzip 解压失败(退出码 ${code}):${err.trim()}`))));
  });
}
