/**
 * 运行目录与回执:每次运行一个 `runs/<runId>/`,里面放**当次**的
 * `project.vr.json` 快照、`plan.json`、`receipt.json` 与产物。
 *
 * 回执是不可变的运行记录 —— 事后要能回答「这一版是哪份工程、哪份计划、
 * 哪个 promptId、实测什么参数、产物多大」,所以工程与计划都留副本,
 * 不靠「事后重算」。进程重启后仍可查回执;状态未知就如实写 unknown,
 * **不自动重投**(设计页:未知状态报告待核)。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Probe } from './media.js';
import type { Plan, PlanTarget } from './plan.js';
import type { Locks, Project } from './project.js';

/** 运行状态。`awaiting-*` 是两阶段流程的中场,不是失败。 */
export type RunState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'awaiting-selection'
  | 'awaiting-alignment'
  | 'unknown';

/** 运行模式:candidates 只出候选,final 出成片。 */
export type RunMode = 'candidates' | 'final';

/** 逐镜头的实测记录。 */
export interface RunShot {
  shotId: string;
  state: 'succeeded' | 'failed' | 'skipped';
  candidateId?: string;
  assetId?: string;
  promptId?: string;
  seed?: number;
  width: number;
  height: number;
  frames: number;
  elapsedMs?: number;
  error?: string;
}

/** 产物校验记录(成片必须带 sha256 与实测参数)。 */
export interface RunOutput {
  path: string;
  sha256: string;
  bytes: number;
  frames: number;
  probe?: Probe;
}

/** 一次运行的检查项 —— 面板与验收都读它。 */
export interface RunChecks {
  projectHashOk: boolean;
  planHashOk: boolean;
  /** 提交给 ComfyUI 的请求数(compose 模式必须是 0)。 */
  comfySubmissions: number;
  /** 新生成的 H3 条数。 */
  h3Requests: number;
  /** 复用的候选数。 */
  reusedCandidates: number;
  ffmpeg?: string;
  vramRequiredBytes?: number;
}

export interface Receipt {
  runId: string;
  projectPath: string;
  projectHash: string;
  planHash: string;
  target: PlanTarget;
  mode: RunMode;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  code?: string;
  locks?: Locks;
  shots: RunShot[];
  outputs: RunOutput[];
  checks: RunChecks;
  logs: string[];
}

/** 一行运行摘要(面板列表与 plan 校准共用)。 */
export interface RunSummary {
  runId: string;
  state: RunState;
  mode: RunMode;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/** 运行 id:`run-20261004-153012-ab12`(可排序、可人读)。 */
export function newRunId(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `run-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 一个工程的运行目录集合。产物路径一律落在本 run 目录里。 */
export class RunStore {
  constructor(readonly projectDir: string) {}

  readonly runsDir = (): string => join(this.projectDir, 'runs');

  dirOf(runId: string): string {
    return join(this.runsDir(), runId);
  }

  snapshotPath(runId: string): string {
    return join(this.dirOf(runId), 'project.vr.json');
  }

  planPath(runId: string): string {
    return join(this.dirOf(runId), 'plan.json');
  }

  receiptPath(runId: string): string {
    return join(this.dirOf(runId), 'receipt.json');
  }

  /** 开一条运行:落工程快照、计划与初始回执。 */
  create(input: {
    runId: string;
    project: Project;
    plan: Plan;
    mode: RunMode;
    projectHash: string;
    logs?: string[];
  }): Receipt {
    mkdirSync(this.dirOf(input.runId), { recursive: true });
    writeFileSync(this.snapshotPath(input.runId), `${JSON.stringify(input.project, null, 2)}\n`, 'utf8');
    writeFileSync(this.planPath(input.runId), `${JSON.stringify(input.plan, null, 2)}\n`, 'utf8');
    const receipt: Receipt = {
      runId: input.runId,
      projectPath: this.projectDir,
      projectHash: input.projectHash,
      planHash: input.plan.planHash,
      target: input.plan.target,
      mode: input.mode,
      state: 'queued',
      startedAt: new Date().toISOString(),
      ...(input.project.locks === undefined ? {} : { locks: input.project.locks }),
      shots: [],
      outputs: [],
      checks: {
        projectHashOk: true,
        planHashOk: true,
        comfySubmissions: 0,
        h3Requests: 0,
        reusedCandidates: input.plan.reuseCandidateIds.length,
      },
      logs: input.logs ?? [],
    };
    this.write(receipt);
    return receipt;
  }

  read(runId: string): Receipt | undefined {
    const file = this.receiptPath(runId);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Receipt;
    } catch {
      return undefined;
    }
  }

  list(): RunSummary[] {
    const dir = this.runsDir();
    if (!existsSync(dir)) return [];
    const summaries: RunSummary[] = [];
    for (const entry of readdirSync(dir)) {
      const receipt = this.read(entry);
      if (receipt === undefined) continue;
      summaries.push({
        runId: receipt.runId,
        state: receipt.state,
        mode: receipt.mode,
        startedAt: receipt.startedAt,
        ...(receipt.finishedAt === undefined ? {} : { finishedAt: receipt.finishedAt }),
        ...(receipt.error === undefined ? {} : { error: receipt.error }),
      });
    }
    return summaries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  /** 改回执(合并式,不改没提的字段)。回执永远重新落盘,不做内存驻留。 */
  update(runId: string, patch: Partial<Receipt>): Receipt {
    const current = this.read(runId);
    if (current === undefined) throw new Error(`没有这条运行:${runId}`);
    const next: Receipt = { ...current, ...patch };
    this.write(next);
    return next;
  }

  /** 追加一行日志(失败点靠它回溯)。 */
  log(runId: string, line: string): Receipt {
    const current = this.read(runId);
    if (current === undefined) throw new Error(`没有这条运行:${runId}`);
    return this.update(runId, { logs: [...current.logs, `${new Date().toISOString()} ${line}`] });
  }

  /** 产物绝对路径:工程里写的是 `runs/<runId>/final.mp4` 这种,必须落在本 run 目录内。 */
  outputPath(runId: string, project: Project): string {
    const declared = project.output.path.replace('<runId>', runId);
    const expectedPrefix = `runs/${runId}/`;
    if (!declared.startsWith(expectedPrefix)) {
      throw new Error(`output.path 要落在本 run 的目录里(期望以 ${expectedPrefix} 开头,收到 ${declared})`);
    }
    return join(this.projectDir, declared);
  }

  private write(receipt: Receipt): void {
    mkdirSync(this.dirOf(receipt.runId), { recursive: true });
    writeFileSync(this.receiptPath(receipt.runId), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }
}
