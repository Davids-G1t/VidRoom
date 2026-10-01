import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import type { AgentDeps } from '../agent.js';
import { DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_SKILL } from './default.js';
import { WorkflowNoKeyError, WorkflowRunner, type WorkflowStepState } from './runner.js';
import {
  parseSkill,
  readSkillFile,
  SaveWorkflowInputSchema,
  toSummary,
  workflowToSkillSource,
  writeSkillFile,
  type SaveWorkflowInput,
  type WorkflowStore,
  type WorkflowSummary,
} from './skill.js';

export type WorkflowJobState =
  | { state: 'idle' }
  | { state: 'running'; workflowId: string; topic: string; steps: WorkflowStepState[] }
  | { state: 'done'; workflowId: string; topic: string; steps: WorkflowStepState[]; video?: unknown }
  | { state: 'error'; workflowId: string; topic: string; steps: WorkflowStepState[]; error: string };

export class WorkflowBusyError extends Error {
  constructor() {
    super('已经有一条工作流在运行,等它完成后再试。');
  }
}

export class WorkflowService implements WorkflowStore {
  private current: WorkflowJobState = { state: 'idle' };
  private running: Promise<void> | null = null;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly root: string,
    private model: LanguageModel | null,
    private readonly tools: AgentDeps,
  ) {}

  setModel(model: LanguageModel | null): void {
    this.model = model;
  }

  hasModel(): boolean {
    return this.model !== null;
  }

  job(): WorkflowJobState {
    return this.current;
  }

  private async ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await mkdir(this.root, { recursive: true });
        const dir = join(this.root, DEFAULT_WORKFLOW_ID);
        const path = join(dir, 'SKILL.md');
        try {
          await stat(path);
        } catch {
          await mkdir(dir, { recursive: true });
          await writeFile(path, DEFAULT_WORKFLOW_SKILL);
        }
      })();
    }
    await this.ready;
  }

  private skillPath(id: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('工作流 id 格式不对');
    return join(this.root, id, 'SKILL.md');
  }

  async list(): Promise<WorkflowSummary[]> {
    await this.ensure();
    const dirs = await readdir(this.root, { withFileTypes: true });
    const defs = await Promise.all(
      dirs
        .filter((d) => d.isDirectory())
        .map(async (d) => {
          try {
            return await readSkillFile(join(this.root, d.name, 'SKILL.md'), d.name);
          } catch {
            return null;
          }
        }),
    );
    return defs
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map(toSummary)
      .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.title.localeCompare(b.title, 'zh-Hans'));
  }

  async source(id: string): Promise<string> {
    await this.ensure();
    return readFile(this.skillPath(id), 'utf8');
  }

  async saveSource(id: string, source: string): Promise<WorkflowSummary> {
    await this.ensure();
    const def = parseSkill(source, id);
    await writeSkillFile(this.root, def.source);
    return toSummary({ ...def, path: this.skillPath(id), updatedAt: new Date().toISOString() });
  }

  async saveWorkflow(input: SaveWorkflowInput): Promise<{ id: string; path: string; title: string }> {
    await this.ensure();
    const data = SaveWorkflowInputSchema.parse(input);
    const source = workflowToSkillSource(data);
    const def = await writeSkillFile(this.root, source);
    return { id: def.id, path: def.path!, title: def.title };
  }

  async startRun(id: string, topic: string): Promise<WorkflowJobState> {
    await this.ensure();
    if (this.running) throw new WorkflowBusyError();
    const def = await readSkillFile(this.skillPath(id), id);
    // 只有要 LLM 写文案的工作流才需要 key;纯剪辑类工作流没有 key 也照跑。
    if (!this.model && def.steps.some((s) => s.tool === 'write_script')) throw new WorkflowNoKeyError();
    const runner = new WorkflowRunner(def, {
      model: this.model,
      tools: this.tools,
      onStep: (steps) => {
        this.current = { state: 'running', workflowId: id, topic, steps };
      },
    });
    this.current = { state: 'running', workflowId: id, topic, steps: def.steps.map((s) => ({ id: s.id, tool: s.tool, state: 'pending' })) };
    this.running = runner
      .run(topic)
      .then((r) => {
        this.current = { state: 'done', workflowId: id, topic, steps: r.steps, video: (r.final as { video?: unknown })?.video ?? r.final };
      })
      .catch((err) => {
        const steps = this.current.state === 'running' ? this.current.steps : def.steps.map((s) => ({ id: s.id, tool: s.tool, state: 'pending' as const }));
        this.current = { state: 'error', workflowId: id, topic, steps, error: err instanceof Error ? err.message : String(err) };
      })
      .finally(() => {
        this.running = null;
      });
    return this.current;
  }

  /** 测试用:等当前后台运行结束。 */
  async waitForIdle(): Promise<void> {
    await this.running;
  }
}
