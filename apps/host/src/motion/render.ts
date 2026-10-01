import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FfmpegPaths } from '../ffmpeg/install.js';

/**
 * 调 HyperFrames CLI(hyperframes@0.8.98,Apache-2.0)把合成渲染成逐帧 PNG,再用 VidRoom 自己那份 LGPL ffmpeg
 * (libopenh264)编成 MP4。
 *
 * 为什么不让 HyperFrames 直接出 MP4:它的 MP4 编码器只认 libx264(GPL)或 VideoToolbox(仅 macOS),
 * 在 VidRoom 锁定的 LGPL ffmpeg 上会直接报 H264EncoderUnavailableError(packages/cli/src/browser/ffmpeg.ts)。
 * png-sequence 这条路不需要 H.264 编码器,编码交给我们自己,许可证链条不变。
 *
 * CLI 用「跑 Host 的同一个可执行文件」来跑:命令行开发时是 node,桌面版是 ELECTRON_RUN_AS_NODE=1 的 Electron
 * (环境变量原样继承给子进程)。HyperFrames 的 CLI 再用 puppeteer-core 起 chrome-headless-shell。
 */

/** HyperFrames 运行时目录(里面有 node_modules/hyperframes);打包版由桌面壳指到 resources/hyperframes */
export const HYPERFRAMES_DIR_ENV = 'VIDROOM_HYPERFRAMES_DIR';

export function hyperframesCli(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env[HYPERFRAMES_DIR_ENV] || fileURLToPath(new URL('../../hyperframes', import.meta.url));
  return join(dir, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
}

/**
 * 发行配置里给 HyperFrames 子进程的环境变量。**这里是遥测开关的唯一定义处**,单测直接断言它。
 * 依据(hyperframes@0.8.98 源码):
 * - packages/cli/src/telemetry/policy.ts:HYPERFRAMES_NO_TELEMETRY 或 DO_NOT_TRACK 取值 1/true/yes/on → 关遥测
 *   (优先于用户配置文件里的开关);两个都设,任一个被改名也还有另一个兜底。
 * - packages/cli/src/utils/updateCheck.ts:HYPERFRAMES_NO_UPDATE_CHECK=1 → 不去 npm 查新版本;
 *   packages/cli/src/utils/autoUpdate.ts:它同时关掉「后台自己 npm install 新版」,HYPERFRAMES_NO_AUTO_INSTALL=1 再关一道。
 *   VidRoom 用的是锁文件里那一版,不许它自己升级。
 * - HYPERFRAMES_BROWSER_PATH:用我们校验过的 chrome-headless-shell,不让它自己去下。
 * - HYPERFRAMES_FFMPEG_PATH / HYPERFRAMES_FFPROBE_PATH(packages/parsers/src/ffBinaries.ts):用 LGPL 那份。
 * - TMPDIR / TEMP / TMP:Chrome 的临时配置目录、Windows 上的渲染工作目录都落在 os.tmpdir(),改到数据目录下。
 * - HOME / USERPROFILE:HyperFrames 不管遥测开没开,都会在 os.homedir() 下建 .hyperframes/(config.json 里有匿名 id、
 *   最近渲染记录;packages/cli/src/telemetry/config.ts),指到数据目录里,不往用户家目录里留东西。
 */
export function hyperframesEnv(o: { base?: NodeJS.ProcessEnv; browser: string; ff: FfmpegPaths; tmpDir: string; homeDir: string }): NodeJS.ProcessEnv {
  return {
    ...(o.base ?? process.env),
    HYPERFRAMES_NO_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    HYPERFRAMES_NO_UPDATE_CHECK: '1',
    HYPERFRAMES_NO_AUTO_INSTALL: '1',
    HYPERFRAMES_BROWSER_PATH: o.browser,
    HYPERFRAMES_FFMPEG_PATH: o.ff.ffmpeg,
    HYPERFRAMES_FFPROBE_PATH: o.ff.ffprobe,
    TMPDIR: o.tmpDir,
    TEMP: o.tmpDir,
    TMP: o.tmpDir,
    HOME: o.homeDir,
    USERPROFILE: o.homeDir,
    NO_COLOR: '1',
  };
}

export class RenderError extends Error {}

export interface RunResult {
  code: number | null;
  output: string;
}

/** 跑一条 HyperFrames 命令;输出只留最后 64 KB(出错时给人看) */
export function runHyperframes(args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<RunResult> {
  const cli = hyperframesCli(env);
  if (!existsSync(cli)) {
    return Promise.reject(new RenderError(`找不到 HyperFrames(${cli})。开发时先跑 pnpm hyperframes:install`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    let output = '';
    const keep = (d: Buffer) => {
      output = (output + d.toString('utf8')).slice(-64 * 1024);
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

/** 合成 → 逐帧 PNG(frame_000001.png …);返回帧数 */
export async function renderFrames(o: {
  projectDir: string;
  framesDir: string;
  fps: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<number> {
  const r = await runHyperframes(
    ['render', o.projectDir, '--format', 'png-sequence', '--output', o.framesDir, '--fps', String(o.fps), '--workers', '2', '--quiet', '--no-best-effort'],
    o.env,
    o.signal,
  );
  const frames = existsSync(o.framesDir) ? (await readdir(o.framesDir)).filter((f) => /^frame_\d+\.png$/.test(f)).length : 0;
  if (r.code !== 0 || frames === 0) {
    const tail = r.output.trim().split('\n').slice(-8).join('\n');
    throw new RenderError(`HyperFrames 渲染失败(退出码 ${r.code},${frames} 帧):${tail}`);
  }
  return frames;
}

/** 逐帧 PNG → MP4:libopenh264(LGPL 构建里的 H.264 编码器),yuv420p,faststart;先写 .part 再改名 */
export async function encodeFrames(ff: FfmpegPaths, o: { framesDir: string; fps: number; width: number; height: number; output: string }): Promise<void> {
  const part = `${o.output}.part`;
  const bitRate = Math.round(o.width * o.height * o.fps * 0.15);
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(o.fps), '-start_number', '1', '-i', join(o.framesDir, 'frame_%06d.png'),
    // 帧是 RGBA:先压到同尺寸黑底上再转 yuv420p,半透明处按 alpha 正确混合(直接丢 alpha 会露出透明像素里的原色)
    '-f', 'lavfi', '-i', `color=c=black:s=${o.width}x${o.height}:r=${o.fps}`,
    '-filter_complex', '[1:v][0:v]overlay=shortest=1:format=auto,format=yuv420p[v]', '-map', '[v]',
    '-c:v', 'libopenh264', '-b:v', String(bitRate), '-r', String(o.fps),
    '-metadata', 'comment=Rendered from code with HyperFrames (no AI model)',
    '-f', 'mp4', '-movflags', '+faststart', part,
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ff.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      child.stderr!.on('data', (d) => (err += d));
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new RenderError(`ffmpeg 编码失败(退出码 ${code}):${err.trim().split('\n').slice(-3).join(' | ')}`))));
    });
    await rename(part, o.output);
  } finally {
    await rm(part, { force: true });
  }
}
