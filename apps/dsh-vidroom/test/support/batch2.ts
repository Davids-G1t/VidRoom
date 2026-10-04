/**
 * 第 2 批测试用的本地夹具:真 ffmpeg 生成的小片 + 一份 schema 合法的工程。
 *
 * 不联网、不碰真 ComfyUI:这一层只用本机 ffmpeg 造素材,再由工程逻辑登记进 assets/。
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { importAsset, writeProject } from '../../src/project-io.js';
import {
  H3_MODEL,
  OUTPUT_METADATA,
  canonicalJson,
  emptyProject,
  projectHash,
  recipeHashOf,
  sha256Of,
  type Candidate,
  type Project,
  type Shot,
} from '../../src/project.js';
import type { MediaTools } from '../../src/media.js';

const run = promisify(execFile);

export const TOOLS: MediaTools = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };

let ffmpegChecked: boolean | undefined;

/** 本机有没有 ffmpeg(CI 上没有就跳过真合成的用例,并在测试名里写明)。 */
export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegChecked !== undefined) return ffmpegChecked;
  try {
    await run('ffmpeg', ['-version']);
    ffmpegChecked = true;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

/** 造一段 24fps 的小片(可选带声音);`color` 用来区分不同素材的字节。 */
export async function makeClip(
  file: string,
  options: { frames?: number; color?: string; tone?: number } = {},
): Promise<void> {
  const frames = options.frames ?? 24;
  const color = options.color ?? 'red';
  mkdirSync(dirname(file), { recursive: true });
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=320x256:rate=24:duration=${(frames / 24).toFixed(3)}`,
  ];
  if (options.tone !== undefined) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=${options.tone}:duration=${(frames / 24).toFixed(3)}`);
  }
  args.push('-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast');
  if (options.tone !== undefined) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  await run('ffmpeg', args);
}

export interface Fixture {
  dir: string;
  project: Project;
  assetIds: string[];
  candidateIds: string[];
  /** 每个镜头选定的候选 id(顺序与 shotIds 一致)。 */
  shotIds: string[];
}

/** 把一段本地视频登记进工程的 assets/ 并登记成一个候选。 */
async function addClip(
  dir: string,
  project: Project,
  file: string,
  shotId: string,
  order: number,
): Promise<{ assetId: string; candidateId: string }> {
  const asset = await importAsset(dir, {
    sourcePath: file,
    kind: 'video',
    origin: 'local',
    existingIds: project.assets.map((item) => item.id),
    tools: TOOLS,
  });
  project.assets.push(asset);
  const frames = asset.probe?.frames ?? 24;
  const fps = asset.probe?.fps ?? { num: 24, den: 1 };
  const candidate: Candidate = {
    id: `cand-${order + 1}`,
    shotId,
    assetId: asset.id,
    recipeHash: recipeHashOf({
      prompt: `夹具镜头 ${order + 1}`,
      seed: 1000 + order,
      width: asset.probe?.width ?? 320,
      height: asset.probe?.height ?? 256,
      frames,
      fps,
    }),
    seed: 1000 + order,
    actual: {
      width: asset.probe?.width ?? 320,
      height: asset.probe?.height ?? 256,
      fps,
      frames,
      audio: asset.probe?.audio ?? false,
    },
    status: 'available',
  };
  project.candidates.push(candidate);
  return { assetId: asset.id, candidateId: candidate.id };
}

/** 造一份「已选片、能合成」的工程:两个镜头 + 一条音轨 + 时间轴。 */
export async function makeFixture(
  dir: string,
  options: { clips?: number; projectId?: string; selected?: boolean } = {},
): Promise<Fixture> {
  const clips = options.clips ?? 2;
  const project = emptyProject(options.projectId ?? 'fixture');
  const assetIds: string[] = [];
  const candidateIds: string[] = [];
  const shotIds: string[] = [];
  const placements: Array<{ shotId: string; startFrame: number; durationFrames: number }> = [];
  let start = 0;

  for (let index = 0; index < clips; index += 1) {
    const file = join(dir, 'input', `clip-${index + 1}.mp4`);
    await makeClip(file, { frames: 24, color: ['red', 'blue', 'green', 'yellow'][index % 4], tone: index === 0 ? 440 : undefined });
    const shotId = `shot-${index + 1}`;
    const added = await addClip(dir, project, file, shotId, index);
    assetIds.push(added.assetId);
    candidateIds.push(added.candidateId);
    shotIds.push(shotId);
    const candidate = project.candidates.find((item) => item.id === added.candidateId);
    const frames = candidate?.actual.frames ?? 24;
    const fps = candidate?.actual.fps ?? { num: 24, den: 1 };
    const shot: Shot = {
      id: shotId,
      order: index,
      generation: {
        model: H3_MODEL,
        prompt: `夹具镜头 ${index + 1}`,
        seed: 1000 + index,
        requestedSeconds: frames / (fps.num / fps.den),
        width: candidate?.actual.width ?? 320,
        height: candidate?.actual.height ?? 256,
        fps,
      },
      candidateIds: [added.candidateId],
      ...(options.selected === false ? {} : { selectedCandidateId: added.candidateId }),
      edit: { inFrame: 0, outFrame: frames, speed: { num: 1, den: 1 }, audio: 'keep' },
    };
    project.shots.push(shot);
    placements.push({ shotId, startFrame: start, durationFrames: frames });
    start += frames;
  }

  project.timeline = { fps: { num: 24, den: 1 }, width: 320, height: 256, placements, totalFrames: start };
  // 夹具一律静音:词锚/音轨那半要真音轨才能测,那部分用单独的对齐夹具。
  project.audio = { mode: 'silent', assetIds: [], alignmentStatus: 'pending' };
  project.styles = [{ id: 'style-1', font: 'Noto Sans CJK SC', size: 32, color: 'white', position: 'bottom-center' }];
  project.output = { container: 'mp4', path: 'runs/<runId>/final.mp4', metadata: OUTPUT_METADATA };

  return { dir, project, assetIds, candidateIds, shotIds };
}

/** 把工程写进 `project.vr.json`(测试里当「人工标注的工程」用)。 */
export function writeFixture(dir: string, project: Project): void {
  mkdirSync(dir, { recursive: true });
  // 夹具也走校验过的写入口:夹具能绕 schema 的话,测试就证不了工程合法性。
  writeProject(dir, project);
}

/** 一个候选/资产的配方哈希(测试里核去重用)。 */
export function recipeOf(prompt: string, seed: number, width: number, height: number, frames: number): string {
  return recipeHashOf({ prompt, seed, width, height, frames, fps: { num: 24, den: 1 } });
}

export function hashOf(project: Project): string {
  return projectHash(project);
}

export function canonical(value: unknown): string {
  return canonicalJson(value);
}

export function digest(value: string): string {
  return sha256Of(value);
}
