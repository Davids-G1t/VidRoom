import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import { createTools, type AgentDeps } from '../agent.js';
import { NO_KEY_MESSAGE } from '../messages.js';
import type { WorkflowDefinition, WorkflowStep } from './skill.js';

export type WorkflowStepState = { id: string; tool: string; state: 'pending' | 'running' | 'done' | 'error'; note?: string };

export class WorkflowNoKeyError extends Error {
  constructor() {
    super(NO_KEY_MESSAGE);
  }
}

const ScriptSchema = z.object({
  caption: z.string().min(1).max(200),
  shots: z.array(z.object({ prompt: z.string().min(1) })),
});

/** ai-sdk `tool()` 造出来的东西里,runner 只用到这两件:参数校验与执行。 */
interface WorkflowToolLike {
  inputSchema?: { parse?(value: unknown): unknown };
  execute?(input: unknown, options: { toolCallId: string }): Promise<unknown>;
}

export interface WorkflowRunnerOptions {
  model: LanguageModel | null;
  tools: AgentDeps;
  onStep?: (states: WorkflowStepState[]) => void;
}

function pathGet(root: unknown, path: string): unknown {
  return path.split('.').reduce((v: unknown, k) => {
    if (v && typeof v === 'object' && k in v) return (v as Record<string, unknown>)[k];
    return undefined;
  }, root);
}

function resolveTemplate(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, ctx));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplate(v, ctx)]));
    }
    return value;
  }
  const exact = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
  if (exact) return pathGet(ctx, exact[1]);
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, p) => String(pathGet(ctx, p) ?? ''));
}

function exposeOutput(raw: unknown): unknown {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const v = r.video;
    if (v && typeof v === 'object' && 'id' in v) return { ...r, id: (v as { id: unknown }).id };
  }
  return raw;
}

function publicId(output: unknown): string | null {
  if (output && typeof output === 'object') {
    const r = output as Record<string, unknown>;
    if (typeof r.id === 'string') return r.id;
    const v = r.video;
    if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return (v as { id: string }).id;
  }
  return null;
}

export class WorkflowRunner {
  private states: WorkflowStepState[];

  constructor(private readonly def: WorkflowDefinition, private readonly o: WorkflowRunnerOptions) {
    this.states = def.steps.map((s) => ({ id: s.id, tool: s.tool, state: 'pending' }));
  }

  private update(id: string, state: WorkflowStepState['state'], note?: string): void {
    this.states = this.states.map((s) => (s.id === id ? { ...s, state, note } : s));
    this.o.onStep?.(this.states);
  }

  async run(topic: string): Promise<{ context: Record<string, unknown>; final: unknown; steps: WorkflowStepState[] }> {
    const ctx: Record<string, unknown> = { topic };
    let final: unknown = null;
    for (const step of this.def.steps) {
      this.update(step.id, 'running');
      try {
        final = await this.runStep(step, ctx);
        ctx[step.id] = final;
        this.update(step.id, 'done', noteFor(final));
      } catch (err) {
        this.update(step.id, 'error', err instanceof Error ? err.message : String(err));
        throw err;
      }
    }
    return { context: ctx, final, steps: this.states };
  }

  private async runStep(step: WorkflowStep, ctx: Record<string, unknown>): Promise<unknown> {
    if (step.each) {
      const items = resolveTemplate(step.each, ctx);
      if (!Array.isArray(items)) throw new Error(`${step.id}.each 没有解析成数组`);
      const outputs: unknown[] = [];
      for (const item of items) {
        const out = await this.runOnce(step, { ...ctx, item });
        outputs.push(out);
      }
      return { outputs, ids: outputs.map(publicId).filter((id): id is string => Boolean(id)) };
    }
    return this.runOnce(step, ctx);
  }

  private async runOnce(step: WorkflowStep, ctx: Record<string, unknown>): Promise<unknown> {
    if (step.tool === 'write_script') return this.writeScript(ctx.topic, step.args?.shots);
    const args = resolveTemplate(step.args ?? {}, ctx) as Record<string, unknown>;
    // ai-sdk 的工具签名带具体入参类型,这里按「schema + execute」这一窄面用,故先收窄再取。
    const tools = createTools(this.o.tools) as unknown as Record<string, WorkflowToolLike>;
    const t = tools[step.tool];
    if (!t?.execute) throw new Error(`工具 ${step.tool} 不可用`);
    const parsed = t.inputSchema?.parse ? t.inputSchema.parse(args) : args;
    const output = await t.execute(parsed, { toolCallId: `workflow-${step.id}` });
    if (output && typeof output === 'object' && 'ok' in output && (output as { ok: unknown }).ok === false) {
      throw new Error(String((output as { reason?: unknown }).reason ?? `${step.tool} 失败`));
    }
    return exposeOutput(output);
  }

  private async writeScript(topic: unknown, shotsArg: unknown): Promise<{ caption: string; shots: Array<{ prompt: string }> }> {
    if (!this.o.model) throw new WorkflowNoKeyError();
    const shots = typeof shotsArg === 'number' && Number.isInteger(shotsArg) && shotsArg > 0 ? shotsArg : 3;
    const result = await generateText({
      model: this.o.model,
      system:
        '你是 VidRoom 工作流里的 write_script 步骤。只输出 JSON,不要 Markdown。JSON 形状必须是 {"caption":"≤200字中文字幕文案","shots":[{"prompt":"180-260 English words prompt"}]}。shots 数量必须匹配用户要求。',
      messages: [
        {
          role: 'user',
          content: `主题:${String(topic)}\n分镜数:${shots}\n请写一行字幕文案和 ${shots} 个 MiniMax H3 英文视频提示词。`,
        },
      ] as ModelMessage[],
    });
    const parsed = ScriptSchema.parse(JSON.parse(result.text.trim()));
    if (parsed.shots.length !== shots) throw new Error(`write_script 返回 ${parsed.shots.length} 个分镜,需要 ${shots} 个`);
    return parsed;
  }
}

function noteFor(value: unknown): string | undefined {
  if (value && typeof value === 'object') {
    const id = publicId(value);
    if (id) return `video:${id}`;
    const ids = (value as { ids?: unknown }).ids;
    if (Array.isArray(ids)) return `ids:${ids.join(',')}`;
  }
  return undefined;
}
