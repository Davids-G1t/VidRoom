/**
 * 本地合成:把时间轴上的镜头、字幕与特效编成**一条可跑的 ffmpeg 命令**(外加同内容的
 * `compose.sh` 落盘),跑完核对产物帧数。
 *
 * 三条硬线:
 * ① 只调本地 `ffmpeg`,字体走工程里的字体资产或本机字体;
 * ② 合成阶段**一次 ComfyUI 请求都不发**(回执里 `comfySubmissions` 必须是 0);
 * ③ 每个镜头的时钟必须与「裁切帧数 + 变速」算出来的帧数一致,对不上直接报错,
 *    不静默拉伸(否则字幕与话音就会错开)。
 */

import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { alignmentFacts, compileTimelineEvents, type CompiledCaption, type CompiledEffect } from './align.js';
import { VidroomError } from './errors.js';
import { probeMedia, runFfmpeg, sha256File, type MediaTools, type Probe } from './media.js';
import type { Project, Shot, Style, Timeline } from './project.js';
import { resolveInside } from './project-io.js';
import type { RunOutput } from './receipts.js';

/** 音轨重采样到的采样率:24 fps 下每帧正好 2000 个采样。 */
const AUDIO_SAMPLE_RATE = 48000;
/** 每帧的采样数(帧 ↔ 采样换算是整数,不漂)。 */
const SAMPLES_PER_FRAME = AUDIO_SAMPLE_RATE / 24;

export interface ComposeOptions {  dir: string;
  runId: string;
  outPath: string;
  tools: MediaTools;
  /** 落盘的 compose.sh 路径(不给就只返回 argv,不写脚本)。 */
  scriptPath?: string;
  projectHash?: string;
  planHash?: string;
}

export interface ComposeCommand {
  argv: string[];
  script: string;
  filterGraph: string;
  outPath: string;
  totalFrames: number;
  captionCount: number;
  effectCount: number;
  inputs: string[];
}

/** ffmpeg 单引号串里的转义(官方写法:引号内用 `\'`)。 */
function q(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ');
}

/** shell 脚本里的参数转义(只用于写 compose.sh,不参与实际执行)。 */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** 变速倍率 → atempo 链(单段只吃 0.5–2;越界就串起来)。 */
export function atempoChain(speed: { num: number; den: number }): string[] {
  let factor = speed.num / speed.den;
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new VidroomError('PROJECT_INVALID', `变速倍率不合法:${speed.num}/${speed.den}`);
  }
  const chain: string[] = [];
  while (factor > 2) {
    chain.push('atempo=2');
    factor /= 2;
  }
  while (factor < 0.5) {
    chain.push('atempo=0.5');
    factor *= 2;
  }
  if (Math.abs(factor - 1) > 1e-6) chain.push(`atempo=${Number(factor.toFixed(6))}`);
  return chain;
}

/** 一个镜头在时间轴上该有的帧数(裁切 + 变速)。 */
export function expectedFrames(shot: Shot): number {
  return Math.round(((shot.edit.outFrame - shot.edit.inFrame) * shot.edit.speed.den) / shot.edit.speed.num);
}

function positionExpressions(position: string, margin: number): { x: string; y: string } {
  switch (position) {
    case 'top-left':
      return { x: String(margin), y: String(margin) };
    case 'top-center':
      return { x: '(w-text_w)/2', y: String(margin) };
    case 'center':
      return { x: '(w-text_w)/2', y: '(h-text_h)/2' };
    case 'bottom-left':
      return { x: String(margin), y: `h-text_h-${margin}` };
    default:
      return { x: '(w-text_w)/2', y: `h-text_h-${margin}` };
  }
}

/** 字体:优先工程里的字体资产(本机文件),否则用样式里写的本机字体名。 */
function fontArgs(style: Style, project: Project, dir: string): string[] {
  if (style.fontAssetId !== undefined) {
    const asset = project.assets.find((item) => item.id === style.fontAssetId);
    if (asset !== undefined) {
      const file = resolveInside(dir, asset.path, `字体资产 ${asset.id}`);
      return [`fontfile='${q(file)}'`];
    }
  }
  if (style.font !== undefined) return [`font='${q(style.font)}'`];
  return [`font='${q(fallbackFontOf(project))}'`];
}

function fallbackFontOf(project: Project): string {
  for (const style of project.styles) {
    if (style.font !== undefined) return style.font;
  }
  return 'Sans';
}

function sizeOf(project: Project): number {
  return project.analysis?.captionStyle.size ?? project.styles[0]?.size ?? 48;
}

interface Segment {
  shot: Shot;
  videoPath: string;
  audioPath?: string;
  /** 音轨来自独立录音(audio.mode=local)而不是候选自带:短了要补静音,保证段长对齐。 */
  localAudio?: true;
  durationFrames: number;
}

/** 把工程编成一条 ffmpeg 命令。缺件、时钟对不上、字幕没落点都直接报错。 */
export function buildComposeCommand(project: Project, options: ComposeOptions): ComposeCommand {
  const timeline = project.timeline;
  if (timeline === undefined) throw new VidroomError('PROJECT_INVALID', '没有 timeline,合成时钟没定');
  const segments = segmentsOf(project, options.dir, timeline);
  const fps = timeline.fps.num / timeline.fps.den;

  const args: string[] = [];
  const filters: string[] = [];
  const inputs: string[] = [];
  const concatLabels: string[] = [];

  let inputIndex = 0;
  const videoInputs: number[] = [];
  for (const segment of segments) {
    args.push('-i', segment.videoPath);
    inputs.push(segment.videoPath);
    videoInputs.push(inputIndex);
    inputIndex += 1;
  }
  // 独立录音要自己占一个输入;候选自带的音轨就长在它自己的视频里,复用同一个输入。
  const audioInputs: number[] = [];
  for (const [position, segment] of segments.entries()) {
    if (segment.audioPath === undefined || segment.audioPath === segment.videoPath) {
      audioInputs.push(videoInputs[position] ?? 0);
      continue;
    }
    args.push('-i', segment.audioPath);
    inputs.push(segment.audioPath);
    audioInputs.push(inputIndex);
    inputIndex += 1;
  }
  const silenceStart = inputIndex;
  for (const segment of segments) {
    if (segment.audioPath !== undefined) continue;
    args.push('-f', 'lavfi', '-t', (segment.durationFrames / fps).toFixed(6), '-i', `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`);
  }
  // 静音段从静音输入那一堆里按顺序取,取完就往下一个段。
  let silenceIndex = silenceStart;

  for (const [position, segment] of segments.entries()) {
    const speed = segment.shot.edit.speed;
    filters.push(
      `[${videoInputs[position]}:v]trim=start_frame=${segment.shot.edit.inFrame}:end_frame=${segment.shot.edit.outFrame},` +
        `setpts=(PTS-STARTPTS)*${speed.den}/${speed.num},fps=${timeline.fps.num}/${timeline.fps.den},` +
        `scale=${timeline.width}:${timeline.height}:force_original_aspect_ratio=decrease,` +
        `pad=${timeline.width}:${timeline.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${position}]`,
    );
    if (segment.audioPath === undefined) {
      filters.push(
        `[${silenceIndex}:a]asetpts=PTS-STARTPTS,aresample=${AUDIO_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[a${position}]`,
      );
      silenceIndex += 1;
    } else {
      // atempo 只在真的变速时才有环节;空字符串会把滤镜链拼出双逗号(ffmpeg 报 No such filter: '')。
      // 裁切用 start_sample/end_sample:atrim 没有 start_frame/end_frame,而先把音轨重采样到
      // 48000 Hz 之后,24 fps 下每帧正好 2000 个采样,帧↔采样换算不会漂。
      const tempo = atempoChain(speed).join(',');
      const crop =
        `atrim=start_sample=${segment.shot.edit.inFrame * SAMPLES_PER_FRAME}:` +
        `end_sample=${segment.shot.edit.outFrame * SAMPLES_PER_FRAME}`;
      // 独立录音可能比这段短(没配到整段),补静音再裁到段长,免得 concat 时音画对不上。
      const pad =
        segment.localAudio === true
          ? `,apad,atrim=duration=${(segment.durationFrames / fps).toFixed(6)}`
          : '';
      filters.push(
        `[${audioInputs[position]}:a]` +
          `aresample=${AUDIO_SAMPLE_RATE},` +
          `${crop},` +
          `asetpts=PTS-STARTPTS,` +
          (tempo === '' ? '' : `${tempo},`) +
          `aformat=sample_fmts=fltp:channel_layouts=stereo${pad}[a${position}]`,
      );
    }
    concatLabels.push(`[v${position}][a${position}]`);
  }
  filters.push(`${concatLabels.join('')}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);

  const compiled = compileTimelineEvents(project);
  if (project.captions.length > 0 && compiled.captions.length !== project.captions.length) {
    throw new VidroomError(
      'ALIGNMENT_REQUIRED',
      `有 ${project.captions.length - compiled.captions.length} 条字幕算不出落点(缺对齐或词被删);先补齐再合成`,
    );
  }
  for (const effect of project.effects) {
    if (!compiled.effects.some((item) => item.id === effect.id)) {
      throw new VidroomError('ALIGNMENT_REQUIRED', `特效 ${effect.id} 的锚点算不出落点;先补齐再合成`);
    }
  }

  const overlays: string[] = [];
  for (const effect of compiled.effects.filter((item) => item.type === 'highlight')) {
    overlays.push(highlightFilter(effect, timeline, fps));
  }
  for (const caption of compiled.captions) {
    overlays.push(captionFilter(caption, timeline, fps, project, options.dir));
  }
  for (const effect of compiled.effects.filter((item) => item.type === 'title-pop')) {
    overlays.push(titlePopFilter(effect, timeline, fps, project));
  }
  const videoOut = overlays.length === 0 ? '[vcat]' : '[vout]';
  if (overlays.length > 0) filters.push(`[vcat]${overlays.join(',')}[vout]`);

  const totalSeconds = timeline.totalFrames / fps;
  const argv = [
    ...args,
    '-filter_complex',
    filters.join(';'),
    '-map',
    videoOut,
    '-map',
    '[acat]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    `${timeline.fps.num}/${timeline.fps.den}`,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-t',
    totalSeconds.toFixed(6),
    '-movflags',
    '+faststart',
    '-metadata',
    `comment=${project.output.metadata}`,
    '-y',
    options.outPath,
  ];

  const header = [
    '#!/usr/bin/env bash',
    '# 由 dsh-vidroom 生成:工程 → 时间轴 → 成片。可以直接跑,用来复现这一版。',
    `# 工程哈希:${options.projectHash ?? '未记'}`,
    `# 计划哈希:${options.planHash ?? '未记'}`,
    `# 运行 id:${options.runId}`,
    `# 帧数:${timeline.totalFrames}(${fps} fps,${totalSeconds.toFixed(2)} 秒)`,
    '# 只调本机 ffmpeg;不联网、不上传。',
    'set -euo pipefail',
    '',
  ].join('\n');
  const script = `${header}ffmpeg -hide_banner -loglevel error \\\n  ${argv
    .map((argument) => shellQuote(argument))
    .join(' \\\n  ')}\n`;

  return {
    argv,
    script,
    filterGraph: filters.join(';'),
    outPath: options.outPath,
    totalFrames: timeline.totalFrames,
    captionCount: compiled.captions.length,
    effectCount: compiled.effects.length,
    inputs,
  };
}

/** 每个镜头 → 一段(视频路径 + 可选音轨路径 + 时长)。 */
function segmentsOf(project: Project, dir: string, timeline: Timeline): Segment[] {
  const segments: Segment[] = [];
  for (const placement of timeline.placements) {
    const shot = project.shots.find((item) => item.id === placement.shotId);
    if (shot === undefined) throw new VidroomError('PROJECT_INVALID', `时间轴上的 ${placement.shotId} 不是镜头`);
    const candidate = project.candidates.find((item) => item.id === shot.selectedCandidateId);
    if (candidate === undefined) {
      throw new VidroomError('CANDIDATE_UNAVAILABLE', `镜头 ${shot.id} 还没选定候选,合成不了`);
    }
    if (candidate.status !== 'available') {
      throw new VidroomError('CANDIDATE_UNAVAILABLE', `镜头 ${shot.id} 的候选 ${candidate.id} 状态是 ${candidate.status}`);
    }
    const asset = project.assets.find((item) => item.id === candidate.assetId);
    if (asset === undefined) {
      throw new VidroomError('CANDIDATE_UNAVAILABLE', `候选 ${candidate.id} 的资产不在工程里`);
    }
    const expected = expectedFrames(shot);
    if (expected !== placement.durationFrames) {
      throw new VidroomError(
        'PROJECT_INVALID',
        `镜头 ${shot.id} 的时钟对不上:时间轴写 ${placement.durationFrames} 帧,裁切+变速算出来 ${expected} 帧`,
      );
    }
    const videoPath = resolveInside(dir, asset.path, `镜头 ${shot.id} 的素材`);
    // 音轨三种模式:
    //   silent —— 一律静音(连候选自带的也不要)
    //   h3     —— 候选自带音轨,且 edit.audio='keep' 时才用
    //   local  —— 用独立录音,靠对齐(alignments)把资产绑定到段
    const mode = project.audio?.mode ?? 'h3';
    const localAudio = mode === 'local' ? localAudioPathOf(project, dir, shot) : undefined;
    const keepAudio =
      mode === 'h3' && shot.edit.audio === 'keep' && (candidate.actual.audio || asset.probe?.audio === true);
    segments.push({
      shot,
      videoPath,
      ...(localAudio !== undefined
        ? { audioPath: localAudio, localAudio: true as const }
        : keepAudio
          ? { audioPath: videoPath }
          : {}),
      durationFrames: placement.durationFrames,
    });
  }
  return segments;
}

/**
 * 本地音轨模式:靠对齐找到这个段自己的录音,再把路径落在工程目录里。
 *
 * 关键在这里**再核一遍对齐现值** —— 面板/工具查出的 `alignmentIssues` 只是操作时的提示,
 * 改文案、改裁切、换音轨之后旧词窗就作废了;合成真用录音时重新核,不拿开工时那份判断当真。
 */
function localAudioPathOf(project: Project, dir: string, shot: Shot): string | undefined {
  const audio = project.audio;
  if (audio === undefined || audio.mode !== 'local' || audio.assetIds.length === 0) return undefined;
  const segmentId = shot.segmentId;
  if (segmentId === undefined) {
    throw new VidroomError(
      'ALIGNMENT_REQUIRED',
      `镜头 ${shot.id} 在本地音轨模式,但没标段(segmentId),配不上录音;先标段并做词对齐`,
    );
  }
  const alignment = project.alignments.find((item) => item.segmentId === segmentId);
  if (alignment === undefined || !audio.assetIds.includes(alignment.assetId)) {
    throw new VidroomError(
      'ALIGNMENT_REQUIRED',
      `镜头 ${shot.id} 在本地音轨模式,但没有找到这个段的录音对齐(段 ${segmentId});先 vidroom_align_words 再把音轨合进来`,
    );
  }
  const facts = alignmentFacts(project, segmentId);
  if (facts.status !== 'ok') {
    throw new VidroomError(
      'ALIGNMENT_REQUIRED',
      `镜头 ${shot.id} 的录音对齐已失效(${facts.reason ?? '未知原因'}),先重新 vidroom_align_words 再合成`,
    );
  }
  const asset = project.assets.find((item) => item.id === alignment.assetId);
  if (asset === undefined) {
    throw new VidroomError('PROJECT_INVALID', `对齐引用的资产 ${alignment.assetId} 不在工程里`);
  }
  return resolveInside(dir, asset.path, `段 ${segmentId} 的独立录音`);
}

function captionFilter(
  caption: CompiledCaption,
  timeline: Timeline,
  fps: number,
  project: Project,
  dir: string,
): string {
  const margin = Math.round(timeline.height * 0.08);
  const { x, y } = positionExpressions(caption.style.position, margin);
  const parts = [
    `text='${q(caption.text)}'`,
    ...fontArgs(caption.style, project, dir),
    `fontsize=${caption.style.size}`,
    `fontcolor=${caption.style.color}`,
    'box=1',
    'boxcolor=black@0.35',
    'boxborderw=12',
    `x=${x}`,
    `y=${y}`,
    `enable='between(t,${(caption.fromFrame / fps).toFixed(6)},${(caption.toFrame / fps).toFixed(6)})'`,
  ];
  return `drawtext=${parts.join(':')}`;
}

function highlightFilter(effect: CompiledEffect, timeline: Timeline, fps: number): string {
  const color = typeof effect.params.color === 'string' ? effect.params.color : '#ffcc00';
  const band = Math.round(timeline.height * 0.18);
  const start = effect.atFrame / fps;
  const end = (effect.atFrame + effect.durationFrames) / fps;
  return [
    'drawbox',
    'x=0',
    `y=${timeline.height - band}`,
    'w=iw',
    `h=${band}`,
    `color=${color}@0.45`,
    't=fill',
    `enable='between(t,${start.toFixed(6)},${end.toFixed(6)})'`,
  ].join(':');
}

function titlePopFilter(effect: CompiledEffect, timeline: Timeline, fps: number, project: Project): string {
  const text = typeof effect.params.text === 'string' ? effect.params.text : '';
  if (text === '') return 'drawbox=w=0:h=0:color=black@0:t=fill';
  const scale = typeof effect.params.scale === 'number' ? effect.params.scale : 1.6;
  const color = typeof effect.params.color === 'string' ? effect.params.color : 'white';
  const font = fontArgs({ font: fallbackFontOf(project), size: sizeOf(project), color, position: 'center' } as Style, project, '');
  const start = effect.atFrame / fps;
  const end = (effect.atFrame + effect.durationFrames) / fps;
  const parts = [
    `text='${q(text)}'`,
    ...font,
    `fontsize=${Math.round(sizeOf(project) * scale)}`,
    `fontcolor=${color}`,
    'box=1',
    'boxcolor=black@0.45',
    'boxborderw=20',
    'x=(w-text_w)/2',
    'y=(h-text_h)/2',
    `alpha='min(1,(t-${start.toFixed(6)})/0.25)'`,
    `enable='between(t,${start.toFixed(6)},${end.toFixed(6)})'`,
  ];
  void timeline;
  return `drawtext=${parts.join(':')}`;
}

/** 合成并核对产物帧数。 */
export async function composeFinal(
  project: Project,
  options: ComposeOptions,
): Promise<{ output: RunOutput; command: ComposeCommand; stderr: string }> {
  const command = buildComposeCommand(project, options);
  mkdirSync(dirname(options.outPath), { recursive: true });
  if (options.scriptPath !== undefined) {
    writeFileSync(options.scriptPath, command.script, 'utf8');
    chmodSync(options.scriptPath, 0o755);
  }
  const stderr = await runFfmpeg(command.argv, options.tools);
  const probe: Probe = await probeMedia(options.outPath, options.tools);
  if (probe.frames !== command.totalFrames) {
    throw new VidroomError('RENDER_FAILED', `成片帧数与时间轴对不上:时间轴 ${command.totalFrames} 帧,产物 ${probe.frames} 帧`);
  }
  return {
    command,
    stderr,
    output: {
      path: options.outPath,
      sha256: await sha256File(options.outPath),
      bytes: statSync(options.outPath).size,
      frames: probe.frames,
      probe,
    },
  };
}
