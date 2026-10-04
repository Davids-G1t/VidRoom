/**
 * 词锚与对齐(设计页里「借 Hypit 的第二点」):
 *
 * ① 先把文案切词,每个词拿一个 id(`speech` 是念的、`display` 是上屏的);
 * ② 音轨做出来之后**人工校订**每个词的 `[startFrame, endFrame)`(段内帧),写进
 *    `alignments` —— 本批不装 ASR,所以 `method` 只能是 `manual`;
 * ③ 字幕与特效**锚在词边界**上,不按整句硬切;合成时按
 *    「段起始帧 + 实测段内帧 + offset」换算成全局帧。
 *
 * 失效判定是这里最要紧的一条:改文案(scriptHash 变)、换音轨(audioHash 变)、
 * 删掉被锚定的词,对齐一律作废,报 `ALIGNMENT_REQUIRED`,绝不拿旧时序硬顶。
 */

import { VidroomError } from './errors.js';
import { H3_FPS } from './frames.js';
import {
  scriptHash as hashScript,
  segmentStartFrame,
  type Alignment,
  type Anchor,
  type Effect,
  type Project,
  type Style,
} from './project.js';

/** 一个词在音轨里的实测位置(段内帧,半开区间)。 */
export interface WordWindow {
  tokenId: string;
  startFrame: number;
  endFrame: number;
}

export interface AlignInput {
  segmentId: string;
  assetId: string;
  audioHash: string;
  scriptHash: string;
  wordWindows: WordWindow[];
}

/** 校订一个段的词时序。任何一处对不上就报 `ALIGNMENT_REQUIRED`。 */
export function buildAlignment(project: Project, input: AlignInput): Alignment {
  const segment = project.script?.segments.find((item) => item.id === input.segmentId);
  if (segment === undefined) {
    throw new VidroomError('PROJECT_INVALID', `script 里没有段 ${input.segmentId}`);
  }
  const asset = project.assets.find((item) => item.id === input.assetId);
  if (asset === undefined) throw new VidroomError('PROJECT_INVALID', `工程里没有资产 ${input.assetId}`);
  if (asset.sha256 !== input.audioHash) {
    throw new VidroomError(
      'ALIGNMENT_REQUIRED',
      `音轨哈希与工程里登记的资产对不上(工程 ${asset.sha256.slice(0, 12)},收到 ${input.audioHash.slice(0, 12)});对齐不能绑错轨`,
    );
  }
  const currentScriptHash = hashScript(project.script);
  if (input.scriptHash !== currentScriptHash) {
    throw new VidroomError(
      'ALIGNMENT_REQUIRED',
      '文案已经改过(scriptHash 不符),旧对齐作废;对着现在的文案重新校订',
    );
  }
  const ownTokens = new Set(segment.tokenIds);
  const seen = new Set<string>();
  let previousEnd = 0;
  for (const window of input.wordWindows) {
    if (!ownTokens.has(window.tokenId)) {
      throw new VidroomError('PROJECT_INVALID', `${window.tokenId} 不属于段 ${segment.id}`);
    }
    if (seen.has(window.tokenId)) throw new VidroomError('PROJECT_INVALID', `${window.tokenId} 给了两次`);
    seen.add(window.tokenId);
    if (window.endFrame <= window.startFrame) {
      throw new VidroomError('PROJECT_INVALID', `${window.tokenId} 的终点要大于起点`);
    }
    if (window.startFrame < previousEnd) {
      throw new VidroomError('PROJECT_INVALID', `${window.tokenId} 与上一个词叠了(词窗要按时间升序、不重叠)`);
    }
    previousEnd = window.endFrame;
  }
  const assetFrames = asset.probe?.frames;
  if (assetFrames !== undefined) {
    for (const window of input.wordWindows) {
      if (window.endFrame > assetFrames) {
        throw new VidroomError(
          'PROJECT_INVALID',
          `${window.tokenId} 的词窗越过音轨长度(${window.endFrame} > ${assetFrames} 帧)`,
        );
      }
    }
  }
  return {
    segmentId: segment.id,
    assetId: asset.id,
    audioHash: asset.sha256,
    scriptHash: currentScriptHash,
    fps: asset.probe?.fps ?? { num: H3_FPS, den: 1 },
    method: 'manual',
    status: 'confirmed',
    words: input.wordWindows.map((window) => ({ ...window })),
  };
}

/** 一个段的对齐现状:`ok` / 缺 / 失效(失效时给出人话理由)。 */
export function alignmentFacts(
  project: Project,
  segmentId: string,
): { status: 'ok' | 'missing' | 'stale'; reason?: string } {
  const alignment = project.alignments.find((item) => item.segmentId === segmentId);
  if (alignment === undefined) return { status: 'missing', reason: `段 ${segmentId} 还没校订词时序` };
  if (alignment.scriptHash !== hashScript(project.script)) {
    return { status: 'stale', reason: `段 ${segmentId} 的对齐是改文案之前做的` };
  }
  const asset = project.assets.find((item) => item.id === alignment.assetId);
  if (asset === undefined) return { status: 'stale', reason: `段 ${segmentId} 的对齐绑的音轨不在工程里了` };
  if (asset.sha256 !== alignment.audioHash) {
    return { status: 'stale', reason: `段 ${segmentId} 的音轨换过,对齐作废` };
  }
  return { status: 'ok' };
}

/** 锚点 → 全局帧。算不出来就返回 undefined(调用方报 unresolved)。 */
export function anchorFrame(project: Project, anchor: Anchor): number | undefined {
  const timeline = project.timeline;
  if (timeline === undefined) return undefined;
  if (anchor.kind === 'shot') {
    const placement = timeline.placements.find((item) => item.shotId === anchor.shotId);
    if (placement === undefined) return undefined;
    return Math.max(0, placement.startFrame + anchor.frame);
  }
  const token = project.script?.tokens.find((item) => item.id === anchor.tokenId);
  if (token === undefined) return undefined;
  const alignment = project.alignments.find((item) => item.segmentId === token.segmentId);
  if (alignment === undefined) return undefined;
  if (alignment.scriptHash !== hashScript(project.script)) return undefined;
  const asset = project.assets.find((item) => item.id === alignment.assetId);
  if (asset === undefined || asset.sha256 !== alignment.audioHash) return undefined;
  const window = alignment.words.find((item) => item.tokenId === token.id);
  if (window === undefined) return undefined;
  const segmentStart = segmentStartFrame(project.shots, timeline, token.segmentId);
  if (segmentStart === undefined) return undefined;
  const local = anchor.edge === 'start' ? window.startFrame : window.endFrame;
  return Math.max(0, segmentStart + local + anchor.offsetFrames);
}

/** 编译好的字幕(全局帧;合成与面板预览共用)。 */
export interface CompiledCaption {
  id: string;
  fromFrame: number;
  toFrame: number;
  text: string;
  style: Style;
}

/** 编译好的特效。 */
export interface CompiledEffect {
  id: string;
  atFrame: number;
  durationFrames: number;
  type: Effect['type'];
  params: Record<string, unknown>;
}

export interface CompileResult {
  captions: CompiledCaption[];
  effects: CompiledEffect[];
  /** 算不出全局帧的锚点 id(缺 timeline、缺对齐、词被删)。 */
  unresolvedAnchors: string[];
  alignmentRequired: boolean;
}

/** 把 `anchors / captions / effects` 编译成全局帧上的事件。 */
export function compileTimelineEvents(project: Project): CompileResult {
  const frames = new Map<string, number | undefined>();
  for (const anchor of project.anchors) frames.set(anchor.id, anchorFrame(project, anchor));
  const unresolvedAnchors = [...frames.entries()].filter(([, frame]) => frame === undefined).map(([id]) => id);
  const frameOf = (id: string): number | undefined => frames.get(id);

  const captions: CompiledCaption[] = [];
  for (const caption of project.captions) {
    const from = frameOf(caption.fromAnchor);
    const to = frameOf(caption.toAnchor);
    const style = project.styles.find((item) => item.id === caption.styleId);
    if (from === undefined || to === undefined || style === undefined) continue;
    const text = caption.tokenIds
      .map((tokenId) => project.script?.tokens.find((token) => token.id === tokenId)?.display ?? '')
      .join('');
    if (text === '') continue;
    captions.push({ id: caption.id, fromFrame: from, toFrame: Math.max(from + 1, to), text, style });
  }

  const effects: CompiledEffect[] = [];
  for (const effect of project.effects) {
    const at = frameOf(effect.atAnchor);
    if (at === undefined) continue;
    effects.push({
      id: effect.id,
      atFrame: at,
      durationFrames: effect.durationFrames,
      type: effect.type,
      params: effect.params,
    });
  }

  return {
    captions,
    effects,
    unresolvedAnchors,
    alignmentRequired: unresolvedAnchors.length > 0,
  };
}

/** 段的对齐检查汇总(工具回报与计划共用)。 */
export function alignmentIssues(project: Project): string[] {
  const issues: string[] = [];
  for (const segment of project.script?.segments ?? []) {
    const facts = alignmentFacts(project, segment.id);
    if (facts.status !== 'ok') issues.push(facts.reason ?? `段 ${segment.id} 对齐有问题`);
  }
  return issues;
}

/** 一个段的词窗(校订时按现状改;给面板与工具读)。 */
export function wordsOf(project: Project, segmentId: string): WordWindow[] {
  const alignment = project.alignments.find((item) => item.segmentId === segmentId);
  return alignment === undefined ? [] : alignment.words.map((word) => ({ ...word }));
}
