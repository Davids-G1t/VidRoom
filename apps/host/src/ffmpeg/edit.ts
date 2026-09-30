import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FfmpegPaths } from './install.js';

/**
 * 三个剪辑操作(按文件路径工作,库与 agent 的接法见 editor.ts):
 * - trimVideo:起点正好在关键帧上 → `-c copy` 流复制(快、不损画质);不在 → 重新编码做精确剪切。
 * - concatVideos:各段编码参数完全一致 → concat demuxer 流复制;不一致 → concat 滤镜统一尺寸/帧率后重新编码。
 * - burnSubtitle:drawtext 把文字像素画进画面,必须重新编码。
 * 重新编码一律 libopenh264(BSD,LGPL 构建里的 H.264 编码器;不用 GPL 的 libx264)+ 原生 aac。
 * 容器元数据(H3 成片里的「AI-generated with MiniMax H3」标注)一律从第一个输入带过来。
 */

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  pixFmt: string;
  /** 形如 "24/1" */
  frameRate: string;
  bitRate: number | null;
}

export interface AudioStreamInfo {
  codec: string;
  sampleRate: number;
  channels: number;
}

export interface MediaInfo {
  duration: number;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
}

export class EditError extends Error {}

function exec(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new EditError(`${file.split(/[\\/]/).pop()} 失败:${String(stderr).trim().split('\n').slice(-3).join(' | ') || err.message}`));
      else resolve(String(stdout));
    });
  });
}

/** 跑 ffmpeg;先写 `<output>.part` 再改名,失败不留半截文件 */
async function ffmpeg(ff: FfmpegPaths, args: string[], output: string): Promise<void> {
  const part = `${output}.part`;
  try {
    await exec(ff.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args, '-f', 'mp4', '-movflags', '+faststart', part]);
    await rename(part, output);
  } finally {
    await rm(part, { force: true });
  }
}

export async function probe(ff: FfmpegPaths, file: string): Promise<MediaInfo> {
  if (!existsSync(file)) throw new EditError(`文件不存在:${file}`);
  const out = JSON.parse(
    await exec(ff.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,bit_rate,sample_rate,channels', '-of', 'json', file]),
  ) as { format?: { duration?: string }; streams?: Array<Record<string, string | number | undefined>> };
  const v = out.streams?.find((s) => s.codec_type === 'video');
  const a = out.streams?.find((s) => s.codec_type === 'audio');
  return {
    duration: Number(out.format?.duration ?? 0),
    video: v
      ? {
          codec: String(v.codec_name),
          width: Number(v.width),
          height: Number(v.height),
          pixFmt: String(v.pix_fmt),
          frameRate: String(v.r_frame_rate),
          bitRate: v.bit_rate ? Number(v.bit_rate) : null,
        }
      : null,
    audio: a ? { codec: String(a.codec_name), sampleRate: Number(a.sample_rate), channels: Number(a.channels) } : null,
  };
}

function fps(rate: string): number {
  const [n, d] = rate.split('/').map(Number);
  return d ? n / d : n || 24;
}

/** 重新编码的视频参数:libopenh264,码率沿用源视频(读不到就按每像素每帧 0.1 bit 估) */
function videoEncodeArgs(v: VideoStreamInfo): string[] {
  const bitRate = v.bitRate ?? Math.round(v.width * v.height * fps(v.frameRate) * 0.1);
  return ['-c:v', 'libopenh264', '-b:v', String(Math.max(bitRate, 500_000)), '-pix_fmt', 'yuv420p'];
}

const AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '192k'];

/** start 之前(含)的关键帧时间;只读包头,不解码 */
export async function keyframesUpTo(ff: FfmpegPaths, file: string, until: number): Promise<number[]> {
  const out = await exec(ff.ffprobe, [
    '-v', 'error', '-select_streams', 'v:0', '-read_intervals', `%+${Math.max(until, 0) + 1}`,
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file,
  ]);
  return out
    .split('\n')
    .map((l) => l.trim().split(','))
    .filter(([t, flags]) => t && t !== 'N/A' && flags?.includes('K'))
    .map(([t]) => Number(t));
}

export interface TrimResult {
  mode: 'copy' | 'reencode';
  note: string;
}

export async function trimVideo(
  ff: FfmpegPaths,
  o: { input: string; output: string; start: number; end: number },
): Promise<TrimResult> {
  const info = await probe(ff, o.input);
  if (!info.video) throw new EditError('输入文件里没有视频流');
  const end = Math.min(o.end, info.duration);
  if (!(o.start >= 0) || !(end > o.start)) {
    throw new EditError(`起止时间不对:start=${o.start},end=${o.end},视频总长 ${info.duration.toFixed(2)} 秒`);
  }
  const halfFrame = 0.5 / fps(info.video.frameRate);
  const onKeyframe = (await keyframesUpTo(ff, o.input, o.start)).some((t) => Math.abs(t - o.start) <= halfFrame);
  const head = ['-ss', String(o.start), '-i', o.input, '-t', String(end - o.start), '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0'];
  if (onKeyframe) {
    await ffmpeg(ff, [...head, '-c', 'copy', '-avoid_negative_ts', 'make_zero'], o.output);
    return { mode: 'copy', note: '起点在关键帧上,流复制,没有重新编码' };
  }
  await ffmpeg(ff, [...head, ...videoEncodeArgs(info.video), ...AUDIO_ENCODE], o.output);
  return { mode: 'reencode', note: '起点不在关键帧上,为了剪得准重新编码了(比流复制慢)' };
}

function sameFormat(a: MediaInfo, b: MediaInfo): boolean {
  const v1 = a.video!;
  const v2 = b.video!;
  if (v1.codec !== v2.codec || v1.width !== v2.width || v1.height !== v2.height || v1.pixFmt !== v2.pixFmt || v1.frameRate !== v2.frameRate) {
    return false;
  }
  if (!a.audio || !b.audio) return !a.audio && !b.audio;
  return a.audio.codec === b.audio.codec && a.audio.sampleRate === b.audio.sampleRate && a.audio.channels === b.audio.channels;
}

/** concat 列表文件里的一行:单引号包住,内部单引号写成 '\'' */
export function concatListLine(path: string): string {
  return `file '${path.replace(/'/g, `'\\''`)}'`;
}

export async function concatVideos(
  ff: FfmpegPaths,
  o: { inputs: string[]; output: string; workDir: string },
): Promise<{ mode: 'copy' | 'reencode'; note: string }> {
  if (o.inputs.length < 2) throw new EditError('拼接至少要两段视频');
  const infos = await Promise.all(o.inputs.map((f) => probe(ff, f)));
  if (infos.some((i) => !i.video)) throw new EditError('有输入文件里没有视频流');

  if (infos.every((i) => sameFormat(i, infos[0]))) {
    const list = join(o.workDir, 'concat.txt');
    await writeFile(list, ['ffconcat version 1.0', ...o.inputs.map(concatListLine), ''].join('\n'));
    await ffmpeg(ff, ['-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', '-map_metadata', '0'], o.output);
    return { mode: 'copy', note: '各段编码参数一致,流复制拼接' };
  }

  const first = infos[0].video!;
  const { width: W, height: H, frameRate: R } = first;
  const withAudio = infos.some((i) => i.audio);
  const args: string[] = [];
  for (const f of o.inputs) args.push('-i', f);
  const parts: string[] = [];
  const labels: string[] = [];
  let extra = o.inputs.length;
  infos.forEach((info, i) => {
    parts.push(
      `[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${R},format=yuv420p[v${i}]`,
    );
    labels.push(`[v${i}]`);
    if (!withAudio) return;
    if (info.audio) {
      parts.push(`[${i}:a:0]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
      labels.push(`[a${i}]`);
    } else {
      // 没声音的段补一段等长静音,拼接滤镜要求每段都有同样的流
      args.push('-f', 'lavfi', '-t', String(info.duration), '-i', 'anullsrc=r=48000:cl=stereo');
      labels.push(`[${extra++}:a]`);
    }
  });
  const n = o.inputs.length;
  const graph = `${parts.join(';')};${labels.join('')}concat=n=${n}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? '[a]' : ''}`;
  args.push('-filter_complex', graph, '-map', '[v]');
  if (withAudio) args.push('-map', '[a]', ...AUDIO_ENCODE);
  args.push(...videoEncodeArgs(first), '-map_metadata', '0');
  await ffmpeg(ff, args, o.output);
  return { mode: 'reencode', note: `各段尺寸/帧率/编码不一致,统一成第一段的 ${W}x${H}、${R} 帧后重新编码` };
}

/**
 * 滤镜参数值的两层转义(ffmpeg-filters 文档「Notes on filtergraph escaping」):
 * 第一层(选项值)转义 \ ' :,第二层(滤镜图)转义 \ ' [ ] , ;。
 */
export function escapeFilterValue(v: string): string {
  const l1 = v.replace(/[\\':]/g, (c) => `\\${c}`);
  return l1.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

export const SUBTITLE_FONT_ENV = 'VIDROOM_SUBTITLE_FONT';

/** 按顺序找第一个存在的字体;前面的都带中文字形,最后一个兜底的只有西文 */
export function fontCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Array<{ path: string; cjk: boolean }> {
  if (platform === 'win32') {
    const dir = join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Fonts');
    return [
      ...['msyh.ttc', 'msyh.ttf', 'simhei.ttf', 'simsun.ttc', 'Deng.ttf'].map((f) => ({ path: join(dir, f), cjk: true })),
      { path: join(dir, 'arial.ttf'), cjk: false },
    ];
  }
  return [
    ...[
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
      '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
      '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    ].map((path) => ({ path, cjk: true })),
    { path: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', cjk: false },
  ];
}

export function findFont(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): { path: string; cjk: boolean } | null {
  if (env[SUBTITLE_FONT_ENV]) {
    const path = env[SUBTITLE_FONT_ENV]!;
    if (!exists(path)) throw new EditError(`${SUBTITLE_FONT_ENV} 指向的字体文件不存在:${path}`);
    return { path, cjk: true };
  }
  return fontCandidates(platform, env).find((f) => exists(f.path)) ?? null;
}

export type SubtitlePosition = 'bottom' | 'top' | 'center';

export async function burnSubtitle(
  ff: FfmpegPaths,
  o: { input: string; output: string; text: string; position?: SubtitlePosition; workDir: string; font?: { path: string; cjk: boolean } | null },
): Promise<{ font: string; note: string }> {
  const text = o.text.trim();
  if (!text) throw new EditError('字幕文字是空的');
  const info = await probe(ff, o.input);
  if (!info.video) throw new EditError('输入文件里没有视频流');
  const font = o.font === undefined ? findFont() : o.font;
  if (!font) throw new EditError(`没找到可用的字体文件,请用环境变量 ${SUBTITLE_FONT_ENV} 指定一个 .ttf/.ttc`);

  // 文字写进文件再用 textfile 读,不经过滤镜转义;expansion=none 让 % 之类按字面显示
  const textFile = join(o.workDir, 'subtitle.txt');
  await writeFile(textFile, text, 'utf8');
  const h = info.video.height;
  const size = Math.max(16, Math.round(h / 14));
  const margin = Math.round(h / 12);
  const y = { bottom: `h-text_h-${margin}`, top: String(margin), center: '(h-text_h)/2' }[o.position ?? 'bottom'];
  const slash = (p: string) => p.replace(/\\/g, '/');
  const drawtext = [
    `fontfile=${escapeFilterValue(slash(font.path))}`,
    `textfile=${escapeFilterValue(slash(textFile))}`,
    'expansion=none',
    'text_align=C',
    `fontsize=${size}`,
    'fontcolor=white',
    'box=1',
    'boxcolor=black@0.5',
    `boxborderw=${Math.round(size / 4)}`,
    `line_spacing=${Math.round(size / 4)}`,
    'x=(w-text_w)/2',
    `y=${y}`,
  ].join(':');
  await ffmpeg(
    ff,
    ['-i', o.input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `drawtext=${drawtext}`, ...videoEncodeArgs(info.video), '-c:a', 'copy', '-map_metadata', '0'],
    o.output,
  );
  const cjkWarning = !font.cjk && /[^\x00-\x7f]/.test(text) ? ';这台电脑上没找到中文字体,非英文字符可能显示成方框' : '';
  return { font: font.path, note: `字幕已烧进画面(重新编码,libopenh264)${cjkWarning}` };
}
