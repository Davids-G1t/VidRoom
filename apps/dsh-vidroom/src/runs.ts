/**
 * 从面板发起的运行记录。面板点「运行」后立刻拿到一个 id,
 * 后面靠轮询这个 id 看进度 —— 出片是分钟级,不能让 HTTP 请求挂在那儿。
 */

import type { MediaRef } from './comfy.js';

export type RunStatus = 'running' | 'success' | 'error';

export interface RunRecord {
  id: string;
  slug: string;
  title: string;
  topic: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  /** ComfyUI 的 prompt_id(每次生成一个)。 */
  promptIds: string[];
  /** 产物。 */
  media: Array<MediaRef & { url: string }>;
  error?: string;
}

/** 内存里的运行记录:重启即清空,面板不需要跨重启的历史。 */
export class RunRegistry {
  private readonly records = new Map<string, RunRecord>();

  constructor(private readonly limit = 20) {}

  start(input: Omit<RunRecord, 'id' | 'startedAt' | 'promptIds' | 'media' | 'status'>): RunRecord {
    const record: RunRecord = {
      ...input,
      id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      status: 'running',
      startedAt: new Date().toISOString(),
      promptIds: [],
      media: [],
    };
    this.records.set(record.id, record);
    this.evict();
    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.records.get(id);
  }

  update(id: string, patch: Partial<RunRecord>): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    Object.assign(record, patch);
    if (patch.status === 'success' || patch.status === 'error') {
      record.finishedAt = new Date().toISOString();
    }
  }

  list(): RunRecord[] {
    return [...this.records.values()].reverse();
  }

  /** 超出上限就丢最老的已完成记录(running 的绝不丢)。 */
  private evict(): void {
    if (this.records.size <= this.limit) return;
    for (const [id, record] of this.records) {
      if (this.records.size <= this.limit) return;
      if (record.status !== 'running') this.records.delete(id);
    }
  }
}
