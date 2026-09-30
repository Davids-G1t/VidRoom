import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { downloadVerified, type DownloadResult } from './download.js';
import { COMFYUI_PORTABLE, portableDownloadUrl } from './manifest.js';

/**
 * ComfyUI 装在哪、怎么起(用哪个 python):
 * - 设了 VIDROOM_COMFYUI_DIR:直接用那个目录(任何平台都认)。Linux 开发机走这条,指向已经装好的
 *   ComfyUI(目录里要有 main.py,python 默认找目录下的 venv/.venv,也可用 VIDROOM_COMFYUI_PYTHON 指定)。
 *   本机路径只放在环境变量里,不进公开仓。
 * - 没设、在 Windows 上:首次使用时下载官方便携包(manifest.ts),解压到数据目录。
 * - 没设、在其它平台:不下载,报错说明要设 VIDROOM_COMFYUI_DIR。
 */

export const COMFYUI_DIR_ENV = 'VIDROOM_COMFYUI_DIR';
export const COMFYUI_PYTHON_ENV = 'VIDROOM_COMFYUI_PYTHON';
export const DATA_DIR_ENV = 'VIDROOM_DATA_DIR';
/** 7za 可执行文件路径;打包版由桌面壳指到安装目录里的 resources/bin/7za.exe */
export const SEVEN_ZIP_ENV = 'VIDROOM_7ZA';

export interface ComfyInstall {
  /** ComfyUI 源码目录(有 main.py) */
  comfyDir: string;
  python: string;
  source: 'local' | 'portable';
}

export interface InstallProgress {
  phase: 'downloading' | 'extracting';
  received?: number;
  total?: number;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  onProgress?: (p: InstallProgress) => void;
  log?: (msg: string) => void;
}

export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env[DATA_DIR_ENV]) return env[DATA_DIR_ENV]!;
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'VidRoom');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'vidroom');
}

export function localInstall(env: NodeJS.ProcessEnv = process.env): ComfyInstall {
  const comfyDir = env[COMFYUI_DIR_ENV]!;
  if (!existsSync(join(comfyDir, 'main.py'))) throw new Error(`${COMFYUI_DIR_ENV} 指向的目录里没有 main.py:${comfyDir}`);
  const python =
    env[COMFYUI_PYTHON_ENV] ||
    ['venv/bin/python', '.venv/bin/python', 'venv/Scripts/python.exe', '.venv/Scripts/python.exe']
      .map((p) => join(comfyDir, p))
      .find((p) => existsSync(p));
  if (!python) throw new Error(`在 ${comfyDir} 下没找到 venv 或 .venv 里的 python,请用 ${COMFYUI_PYTHON_ENV} 指定`);
  return { comfyDir, python, source: 'local' };
}

export function portableLayout(root: string) {
  const installDir = join(root, 'runtime', `comfyui-portable-${COMFYUI_PORTABLE.version}`);
  const top = join(installDir, COMFYUI_PORTABLE.rootDir);
  return {
    installDir,
    marker: join(installDir, '.vidroom-installed.json'),
    archive: join(root, 'downloads', COMFYUI_PORTABLE.fileName),
    comfyDir: join(top, 'ComfyUI'),
    python: join(top, 'python_embeded', 'python.exe'),
  };
}

export async function resolveComfyInstall(opts: ResolveOptions = {}): Promise<ComfyInstall> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (env[COMFYUI_DIR_ENV]) return localInstall(env);
  if (platform !== 'win32') {
    throw new Error(`这个平台上不下载 ComfyUI:请用环境变量 ${COMFYUI_DIR_ENV} 指向已装好的 ComfyUI 目录`);
  }
  const { install } = await ensurePortable(dataDir(env, platform), opts);
  return install;
}

/** Windows:下载 + 校验 + 解压官方便携包;已经装好(有标记文件且版本一致)就直接返回。 */
export async function ensurePortable(
  root: string,
  opts: ResolveOptions = {},
): Promise<{ install: ComfyInstall; download: DownloadResult | null }> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const layout = portableLayout(root);
  const install: ComfyInstall = { comfyDir: layout.comfyDir, python: layout.python, source: 'portable' };

  if (await markerMatches(layout.marker)) return { install, download: null };

  await mkdir(join(root, 'downloads'), { recursive: true });
  const url = portableDownloadUrl(env);
  log(`[comfyui] 下载便携包 ${url}`);
  const download = await downloadVerified({
    url,
    dest: layout.archive,
    size: COMFYUI_PORTABLE.size,
    sha256: COMFYUI_PORTABLE.sha256,
    signal: opts.signal,
    log,
    onProgress: (received, total) => opts.onProgress?.({ phase: 'downloading', received, total }),
  });
  log(`[comfyui] 下载完成,sha256 与清单一致:${COMFYUI_PORTABLE.sha256}`);

  opts.onProgress?.({ phase: 'extracting' });
  const tmp = `${layout.installDir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await extract7z(sevenZipPath(env), layout.archive, tmp);
  for (const rel of [['python_embeded', 'python.exe'], ['ComfyUI', 'main.py']]) {
    const p = join(tmp, COMFYUI_PORTABLE.rootDir, ...rel);
    if (!existsSync(p)) throw new Error(`解压后找不到 ${p}`);
  }
  await rm(layout.installDir, { recursive: true, force: true });
  await rename(tmp, layout.installDir);
  await writeFile(layout.marker, JSON.stringify({ version: COMFYUI_PORTABLE.version, sha256: COMFYUI_PORTABLE.sha256 }));
  await rm(layout.archive, { force: true });
  log(`[comfyui] 已解压到 ${layout.installDir}`);
  return { install, download };
}

async function markerMatches(marker: string): Promise<boolean> {
  try {
    const m = JSON.parse(await readFile(marker, 'utf8')) as { version?: string; sha256?: string };
    return m.version === COMFYUI_PORTABLE.version && m.sha256 === COMFYUI_PORTABLE.sha256;
  } catch {
    return false;
  }
}

export function sevenZipPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env[SEVEN_ZIP_ENV]) return env[SEVEN_ZIP_ENV]!;
  // 运行时再 require:Host 被 esbuild 打成单文件后没有 node_modules,打包版一律走 VIDROOM_7ZA
  return (createRequire(import.meta.url)('7zip-bin') as { path7za: string }).path7za;
}

export function extract7z(sevenZip: string, archive: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZip, ['x', archive, `-o${outDir}`, '-y', '-bso0', '-bsp0'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let err = '';
    child.stderr!.on('data', (d) => (err += d));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`7za 解压失败(退出码 ${code}):${err.trim()}`))));
  });
}
