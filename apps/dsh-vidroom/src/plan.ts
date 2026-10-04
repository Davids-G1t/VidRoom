/**
 * 计划:只读工程与依赖,输出「要做什么」——不生成、不下载、不提交 ComfyUI。
 *
 * 两阶段(设计页的硬约束):
 *   ① `target: "candidates"` 只规划镜头候选,不要求还没有音轨的词对齐,完成后停在
 *      `awaiting-selection / awaiting-alignment`;
 *   ② 选定候选并校订词时序之后,`target: "final"` 才规划合成。
 * 所以不会有「还没生成音轨就先要对齐」的死锁。
 *
 * 估值只用**本机相同的机器/权重/尺寸/帧数**实测过的记录(读 runs/<runId>/receipt.json);
 * 没有校准就如实写 null + basis,不拿旧平台的数字承诺本机速度。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { alignmentFacts, anchorFrame, compileTimelineEvents } from './align.js';
import { h3WorkflowHash } from './adapter.js';
import { VidroomError } from './errors.js';
import { H3_FPS, framesForSeconds } from './frames.js';
import { sha256File, type Fps, type MediaTools } from './media.js';
import {
  canonicalJson,
  H3_MODEL,
  projectHash,
  recipeHashOf,
  segmentStartFrame,
  sha256Of,
  type Budget,
  type Project,
  type Shot,
} from './project.js';
import { resolveInside } from './project-io.js';
import type { Receipt } from './receipts.js';

export type PlanTarget = 'candidates' | 'final';

export interface NewRequest {
  shotId: string;
  recipeHash: string;
  seed?: number;
  width: number;
  height: number;
  fps: Fps;
  frames: number;
  prompt: string;
}

export interface Plan {
  planHash: string;
  projectHash: string;
  target: PlanTarget;
  dag: string[];
  reuseCandidateIds: string[];
  newRequests: NewRequest[];
  estimates: {
    wallSeconds: { low: number; high: number } | null;
    vramBytes: number | null;
    ramBytes: number | null;
    diskBytes: number | null;
    basis: string;
  };
  budget: Budget;
  blockers: string[];
  ready: boolean;
}

export interface PlanOptions {
  dir: string;
  target: PlanTarget;
  budget?: Partial<Budget>;
  /** 是否核一遍用到的资产的 sha256(默认核)。 */
  verifyHashes?: boolean;
  /** 校准记录(不给就去 `runs/` 里找)。 */
  receipts?: Receipt[];
}

/** 一条候选请求的配方(去重与回执都用它)。 */
export function requestFor(shot: Shot, workflowHash?: string): NewRequest {
  const frames = framesForSeconds(shot.generation.requestedSeconds);
  return {
    shotId: shot.id,
    recipeHash: recipeHashOf({
      prompt: shot.generation.prompt,
      ...(shot.generation.seed === undefined ? {} : { seed: shot.generation.seed }),
      width: shot.generation.width,
      height: shot.generation.height,
      frames,
      fps: shot.generation.fps,
      ...(workflowHash === undefined ? {} : { workflowHash }),
    }),
    ...(shot.generation.seed === undefined ? {} : { seed: shot.generation.seed }),
    width: shot.generation.width,
    height: shot.generation.height,
    fps: shot.generation.fps,
    frames,
    prompt: shot.generation.prompt,
  };
}

/** 读本工程的运行回执(校准来源)。读不出来的目录直接跳过,不静默改数。 */
export function readReceipts(dir: string): Receipt[] {
  const runsDir = join(dir, 'runs');
  if (!existsSync(runsDir)) return [];
  const receipts: Receipt[] = [];
  for (const entry of readdirSync(runsDir)) {
    const file = join(runsDir, entry, 'receipt.json');
    if (!existsSync(file)) continue;
    try {
      receipts.push(JSON.parse(readFileSync(file, 'utf8')) as Receipt);
    } catch {
      continue;
    }
  }
  return receipts;
}

/**
 * 某个规格的实测耗时(每秒/条)。只收**这次同样环境、同样规格、成功跑完**的样本:
 * - 失败/中断的不算(跑炸的耗时不是耗时);
 * - 回执里记了工作流哈希、与现在这份对不上就不收(换了图就不是一回事);
 * - 尺寸/帧数必须与这条请求完全一致,不拿别的规格推。
 */
function calibrate(receipts: Receipt[], request: NewRequest, workflowHash: string): number | undefined {
  const samples: number[] = [];
  for (const receipt of receipts) {
    const locked = receipt.locks?.workflow?.sha256;
    if (locked !== undefined && locked !== workflowHash) continue;
    for (const shot of receipt.shots ?? []) {
      if (shot.state !== 'succeeded') continue;
      if (shot.width !== request.width || shot.height !== request.height || shot.frames !== request.frames) continue;
      if (typeof shot.elapsedMs !== 'number' || shot.elapsedMs <= 0) continue;
      samples.push(shot.elapsedMs / 1000);
    }
  }
  if (samples.length === 0) return undefined;
  const recent = samples.slice(-5);
  return recent.reduce((total, item) => total + item, 0) / recent.length;
}

/** 从历史回执里读到的显存占用(只认同样工作流的记录;有就报,没有就是 null)。 */
function measuredVram(receipts: Receipt[], workflowHash: string): number | null {
  for (const receipt of receipts) {
    const locked = receipt.locks?.workflow?.sha256;
    if (locked !== undefined && locked !== workflowHash) continue;
    const value = receipt.checks?.vramRequiredBytes;
    if (typeof value === 'number' && value > 0) return value;
  }
  return null;
}

/** 规划。任何一条 blocker 都会让 `ready` 为假 —— 调用方不该往下走。 */
export async function buildPlan(project: Project, options: PlanOptions): Promise<Plan> {
  const { dir, target } = options;
  const budget = { ...project.budget, ...options.budget };
  const blockers: string[] = [];
  const requests: NewRequest[] = [];
  const reuse: string[] = [];
  const dag: string[] = [];
  const workflowHash = project.locks?.workflow?.sha256;

  if (!existsSync(join(dir, 'project.vr.json'))) {
    blockers.push('工程文件不在(project.vr.json)');
  }

  if (target === 'candidates') {
    for (const shot of [...project.shots].sort((a, b) => a.order - b.order)) {
      if (shot.generation.model !== H3_MODEL) blockers.push(`镜头 ${shot.id} 的模型不是 ${H3_MODEL}`);
      if (shot.generation.fps.num !== H3_FPS || shot.generation.fps.den !== 1) {
        blockers.push(`镜头 ${shot.id} 的 fps 不是 ${H3_FPS}(本机 H3 底座只跑 24 fps)`);
      }
      if (shot.generation.width % 32 !== 0 || shot.generation.height % 32 !== 0) {
        blockers.push(`镜头 ${shot.id} 的宽高没对齐 32 的倍数`);
      }
      const selected = project.candidates.find((candidate) => candidate.id === shot.selectedCandidateId);
      if (selected !== undefined && selected.status === 'available') {
        reuse.push(selected.id);
        dag.push(`复用候选 ${selected.id}(镜头 ${shot.id})`);
        continue;
      }
      if (selected !== undefined && selected.status !== 'available') {
        blockers.push(`镜头 ${shot.id} 选定的候选 ${selected.id} 状态是 ${selected.status},不能用`);
      }
      // 合格 = 跟当前配方(提示词/种子/尺寸/帧数/工作流)对得上的候选。
      // 改过提示词的工程里那些旧配方候选不算数 —— 不然改片之后永远卡在这里生成不了新的。
      const request = requestFor(shot, workflowHash);
      const usable = project.candidates.filter(
        (candidate) =>
          shot.candidateIds.includes(candidate.id) &&
          candidate.recipeHash === request.recipeHash &&
          candidate.status === 'available',
      );
      if (usable.length > 0 && shot.selectedCandidateId === undefined) {
        blockers.push(
          `镜头 ${shot.id} 已经有这条配方的合格候选(${usable.map((item) => item.id).join('、')}):先显式选定一个再复用,或者改提示词/种子换一条新配方`,
        );
      }
      dag.push(`生成本地候选 h3(镜头 ${shot.id},${request.width}x${request.height} · ${request.frames} 帧)`);
      if (!requests.some((item) => item.recipeHash === request.recipeHash)) requests.push(request);
    }
    if (project.shots.length === 0) blockers.push('还没有目标镜头(shots)');
  } else {
    if (project.timeline === undefined) {
      blockers.push('还没有 timeline,合成时钟没定');
    }
    if (project.shots.length === 0) blockers.push('还没有目标镜头(shots)');
    for (const shot of project.shots) {
      const selected = project.candidates.find((candidate) => candidate.id === shot.selectedCandidateId);
      if (selected === undefined) {
        blockers.push(`镜头 ${shot.id} 还没选定候选`);
        continue;
      }
      if (selected.status !== 'available') {
        blockers.push(`镜头 ${shot.id} 的候选 ${selected.id} 状态是 ${selected.status}`);
        continue;
      }
      reuse.push(selected.id);
      dag.push(`取镜头 ${shot.id} 的候选 ${selected.id}`);
      const expected = Math.round(((shot.edit.outFrame - shot.edit.inFrame) * shot.edit.speed.den) / shot.edit.speed.num);
      const placement = project.timeline?.placements.find((item) => item.shotId === shot.id);
      if (placement !== undefined && placement.durationFrames !== expected) {
        blockers.push(
          `镜头 ${shot.id} 的时钟与裁切对不上:placement ${placement.durationFrames} 帧,裁切+变速算出来 ${expected} 帧`,
        );
      }
    }
    // 缺词对齐只阻断合成,不阻断候选阶段。
    const wordSegments = new Set<string>();
    for (const anchor of project.anchors) {
      if (anchor.kind !== 'word') continue;
      const token = project.script?.tokens.find((item) => item.id === anchor.tokenId);
      if (token !== undefined) wordSegments.add(token.segmentId);
    }
    for (const segmentId of wordSegments) {
      const facts = alignmentFacts(project, segmentId);
      if (facts.status !== 'ok') {
        blockers.push(`${facts.reason ?? `段 ${segmentId} 的对齐有问题`}(ALIGNMENT_REQUIRED)`);
      }
      if (project.timeline !== undefined && segmentStartFrame(project.shots, project.timeline, segmentId) === undefined) {
        blockers.push(`段 ${segmentId} 在时间轴上没有落点,词锚换算不了全局帧`);
      }
    }
    // 锚点/字幕/特效的落点:算不出来就是明确失败 —— 删了被引用的词、改了稿、镜头没落点
    // 都会落到这里,绝不允许拿旧时间窗接着用。
    const danglingAnchors = project.anchors.filter((anchor) => anchorFrame(project, anchor) === undefined);
    if (danglingAnchors.length > 0) {
      blockers.push(
        `有 ${danglingAnchors.length} 个锚点算不出全局帧(${danglingAnchors.map((anchor) => anchor.id).join('、')}):被引用的词/镜头改过了(ALIGNMENT_REQUIRED)`,
      );
    }
    const compiled = compileTimelineEvents(project);
    if (compiled.unresolvedAnchors.length > 0) {
      blockers.push(`有 ${compiled.unresolvedAnchors.length} 个字幕/特效落不下来(ALIGNMENT_REQUIRED)`);
    }
    dag.push(`按 timeline 合成 ${project.timeline?.totalFrames ?? 0} 帧 → final.mp4`);
  }

  if (requests.length > budget.maxNewCandidates) {
    blockers.push(`新请求 ${requests.length} 条超出预算 maxNewCandidates=${budget.maxNewCandidates}(BUDGET_EXCEEDED)`);
  }
  if (options.verifyHashes !== false) {
    blockers.push(...(await verifyUsedAssets(project, dir)));
  }

  const receipts = options.receipts ?? readReceipts(dir);
  const currentWorkflowHash = h3WorkflowHash();
  const perRequest = requests.map((request) => calibrate(receipts, request, currentWorkflowHash));
  const uncalibrated = perRequest.filter((value) => value === undefined).length;
  const sum = perRequest.reduce<number>((total, value) => total + (value ?? 0), 0);
  const wallSeconds =
    uncalibrated > 0 || perRequest.length === 0
      ? null
      : { low: Number((sum * 0.8).toFixed(1)), high: Number((sum * 1.25).toFixed(1)) };
  const vramBytes = measuredVram(receipts, currentWorkflowHash);
  const inputBytes = measureInputs(project, dir);
  const estimates: Plan['estimates'] = {
    wallSeconds,
    vramBytes,
    ramBytes: null,
    diskBytes: inputBytes,
    basis: [
      wallSeconds === null
        ? `耗时未校准:${uncalibrated}/${requests.length} 条没有同规格、同工作流、成功的本机实测记录,不拿旧平台数字顶`
        : `耗时按本机同规格成功实测逐条相加 = ${sum.toFixed(1)} 秒(上下浮动按 ±20%/25%)`,
      vramBytes === null ? '显存没有（同工作流的）实测记录,写 null' : '显存取自历史回执',
      inputBytes === null ? '磁盘没法量(有资产文件不在)' : '磁盘只算了要用到的输入素材之和,成片体积未校准',
    ].join(';'),
  };

  // 预算:耗时/磁盘也要拦。没校准(null)就不拦 —— 不拿猜的数字当预算判据。
  if (estimates.wallSeconds !== null && estimates.wallSeconds.low > budget.maxWallSeconds) {
    blockers.push(
      `预计最少 ${estimates.wallSeconds.low} 秒,超预算 maxWallSeconds=${budget.maxWallSeconds}(BUDGET_EXCEEDED)`,
    );
  }
  if (estimates.diskBytes !== null && estimates.diskBytes > budget.maxDiskBytes) {
    blockers.push(
      `要用到的素材 ${estimates.diskBytes} 字节,超预算 maxDiskBytes=${budget.maxDiskBytes}(BUDGET_EXCEEDED)`,
    );
  }

  const draft: Omit<Plan, 'planHash'> = {
    projectHash: projectHash(project),
    target,
    dag,
    reuseCandidateIds: reuse,
    newRequests: requests,
    estimates,
    budget,
    blockers,
    ready: blockers.length === 0,
  };
  return { planHash: planHashOf(draft), ...draft };
}

/**
 * 计划的指纹。**不含 `estimates`** —— 估值是从历史回执里现算的,
 * 同批第一条跑完就会变;把它算进哈希,同一批的后几条会被自己的回执照着拒掉(PLAN_HASH_MISMATCH)。
 * 冻的是「要干什么」(dag/请求/复用/预算/阻碍),估算只是报给人看的。
 */
export function planHashOf(plan: Omit<Plan, 'planHash'>): string {
  const { estimates: _estimates, ...stable } = plan;
  return sha256Of(canonicalJson(stable));
}

/** 用到的资产必须真在、且 sha256 对得上(工程内相对路径,不许越界)。 */
async function verifyUsedAssets(project: Project, dir: string): Promise<string[]> {
  const problems: string[] = [];
  const used = new Set<string>();
  if (project.reference !== undefined) used.add(project.reference.assetId);
  for (const shot of project.shots) {
    const selected = project.candidates.find((candidate) => candidate.id === shot.selectedCandidateId);
    if (selected !== undefined) used.add(selected.assetId);
  }
  for (const alignment of project.alignments) used.add(alignment.assetId);
  for (const asset of project.assets) {
    if (!used.has(asset.id)) continue;
    try {
      const file = resolveInside(dir, asset.path, `资产 ${asset.id} 的路径`);
      const actual = await sha256File(file);
      if (actual !== asset.sha256) problems.push(`资产 ${asset.id} 的文件内容与登记 sha256 不一致(被改过?)`);
    } catch (error) {
      problems.push(`资产 ${asset.id}:${(error as Error).message}`);
    }
  }
  return problems;
}

/** 量一遍要用到的输入素材字节数;有一个量不到就返回 null(=不知道)。 */
function measureInputs(project: Project, dir: string): number | null {
  let total = 0;
  for (const shot of project.shots) {
    const selected = project.candidates.find((candidate) => candidate.id === shot.selectedCandidateId);
    if (selected === undefined) continue;
    const asset = project.assets.find((item) => item.id === selected.assetId);
    if (asset === undefined) return null;
    try {
      total += statSync(resolveInside(dir, asset.path, `资产 ${asset.id} 的路径`)).size;
    } catch {
      return null;
    }
  }
  if (total === 0) return null;
  const reference = project.reference === undefined
    ? 0
    : project.assets.find((item) => item.id === project.reference?.assetId)?.path;
  if (typeof reference === 'string') {
    try {
      total += statSync(resolveInside(dir, reference, '参考片路径')).size;
    } catch {
      return null;
    }
  }
  return total;
}

/** 计划的哈希核对(render 前用)。 */
export function assertPlanHash(plan: Plan, expected: string): void {
  if (plan.planHash !== expected) {
    throw new VidroomError('PLAN_HASH_MISMATCH', `计划已变(现在是 ${plan.planHash.slice(0, 12)});重新 plan 再渲染`);
  }
}

export { framesForSeconds };
