import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * 工作流 steps 只允许本机工具。
 * 云端生成(cloud_generate_video / cloud_generate_image)故意不在里面:那两个工具在聊天里只估价、
 * 必须用户在估价卡上点确认才花钱,工作流是「跑一次出一串产物」的形态,没有中途确认这一说,
 * 所以云端步骤现在存不了、也跑不了。要支持得先给 runner 加「跑到云端步骤就停下等确认」的状态机。
 */
export const WORKFLOW_TOOLS = ['write_script', 'generate_video', 'trim_video', 'concat_videos', 'add_subtitle', 'render_motion', 'list_videos'] as const;

export const WorkflowStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  tool: z.enum(WORKFLOW_TOOLS),
  each: z.string().optional(),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const SaveWorkflowInputSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(200),
  steps: z.array(WorkflowStepSchema).min(1),
});
export type SaveWorkflowInput = z.infer<typeof SaveWorkflowInputSchema>;

export interface WorkflowDefinition extends SaveWorkflowInput {
  id: string;
  builtin: boolean;
  body: string;
  source: string;
  path?: string;
  updatedAt?: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  title: string;
  description: string;
  builtin: boolean;
  steps: number;
  /** 步骤里有本地出片(generate_video)时为真:没显卡档时前端拿它决定收不收「运行」 */
  needsLocalGpu: boolean;
  updatedAt: string | null;
}

export interface WorkflowStore {
  saveWorkflow(input: SaveWorkflowInput): Promise<{ id: string; path: string; title: string }>;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function parseScalar(raw: string): string | boolean {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function parseFrontmatter(text: string): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`frontmatter 第 ${i + 1} 行不是 key: value`);
    out[m[1]] = parseScalar(m[2]);
  }
  return out;
}

function parseInlineObject(raw: string): Record<string, unknown> {
  const jsonish = raw
    .trim()
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/'/g, '"');
  const v = JSON.parse(jsonish) as unknown;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('args 必须是对象');
  return v as Record<string, unknown>;
}

export function parseWorkflowSteps(block: string): WorkflowStep[] {
  const lines = block.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines[0]?.trim() !== 'steps:') throw new Error('workflow 围栏必须以 steps: 开头');
  const steps: WorkflowStep[] = [];
  let cur: Partial<WorkflowStep> | null = null;
  const finish = () => {
    if (!cur) return;
    const parsed = WorkflowStepSchema.parse({ ...cur, args: cur.args ?? {} });
    steps.push(parsed);
    cur = null;
  };
  for (const [idx, line] of lines.slice(1).entries()) {
    let m = /^\s*-\s+id:\s*([A-Za-z][A-Za-z0-9-]*)\s*$/.exec(line);
    if (m) {
      finish();
      cur = { id: m[1] };
      continue;
    }
    if (!cur) throw new Error(`workflow 第 ${idx + 2} 行必须先写 - id:`);
    m = /^\s+tool:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
    if (m) {
      cur.tool = m[1] as WorkflowStep['tool'];
      continue;
    }
    m = /^\s+each:\s*(.+)\s*$/.exec(line);
    if (m) {
      cur.each = parseScalar(m[1]) as string;
      continue;
    }
    m = /^\s+args:\s*(\{.*\})\s*$/.exec(line);
    if (m) {
      cur.args = parseInlineObject(m[1]);
      continue;
    }
    throw new Error(`workflow 第 ${idx + 2} 行无法解析:${line.trim()}`);
  }
  finish();
  if (!steps.length) throw new Error('workflow 至少要有一个 step');
  return steps;
}

export function parseSkill(source: string, expectedId?: string): WorkflowDefinition {
  const front = FRONT.exec(source);
  if (!front) throw new Error('SKILL.md 必须以 YAML frontmatter 开头');
  const meta = parseFrontmatter(front[1]);
  const name = meta.name;
  const title = meta.title;
  const description = meta.description;
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('frontmatter.name 必须是 ascii 短横线 slug');
  if (expectedId && name !== expectedId) throw new Error(`frontmatter.name(${name}) 必须等于目录名(${expectedId})`);
  if (typeof title !== 'string' || !title.trim()) throw new Error('frontmatter.title 必须是非空字符串');
  if (typeof description !== 'string' || !description.trim()) throw new Error('frontmatter.description 必须是非空字符串');
  const fence = /```workflow\s*\r?\n([\s\S]*?)\r?\n```/.exec(source.slice(front[0].length));
  if (!fence) throw new Error('SKILL.md 必须包含 ```workflow 围栏');
  const steps = parseWorkflowSteps(fence[1]);
  return {
    id: name,
    name,
    title,
    description,
    builtin: meta.builtin === true,
    body: source.slice(front[0].length),
    steps,
    source,
  };
}

function oneLineArgs(args: Record<string, unknown>): string {
  return `{ ${Object.entries(args)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(', ')} }`;
}

export function workflowToSkillSource(input: SaveWorkflowInput & { builtin?: boolean; body?: string }): string {
  const data = SaveWorkflowInputSchema.parse(input);
  const body = input.body?.trim() || `# ${data.title}\n\n${data.description}`;
  const steps = data.steps
    .map((s) => {
      const lines = [`  - id: ${s.id}`, `    tool: ${s.tool}`];
      if (s.each) lines.push(`    each: ${JSON.stringify(s.each)}`);
      lines.push(`    args: ${oneLineArgs(s.args ?? {})}`);
      return lines.join('\n');
    })
    .join('\n');
  return `---\nname: ${data.name}\ntitle: ${data.title}\ndescription: ${data.description}\n${input.builtin ? 'builtin: true\n' : ''}---\n${body}\n\n\`\`\`workflow\nsteps:\n${steps}\n\`\`\`\n`;
}

export async function readSkillFile(path: string, id: string): Promise<WorkflowDefinition> {
  const source = await readFile(path, 'utf8');
  const def = parseSkill(source, id);
  const st = await stat(path);
  return { ...def, path, updatedAt: st.mtime.toISOString() };
}

export async function writeSkillFile(dir: string, source: string): Promise<WorkflowDefinition> {
  const def = parseSkill(source);
  await mkdir(join(dir, def.name), { recursive: true });
  const path = join(dir, def.name, 'SKILL.md');
  const tmp = `${path}.tmp`;
  await writeFile(tmp, source);
  await rename(tmp, path);
  return { ...def, path, updatedAt: new Date().toISOString() };
}

export function toSummary(def: WorkflowDefinition): WorkflowSummary {
  return {
    id: def.id,
    name: def.name,
    title: def.title,
    description: def.description,
    builtin: def.builtin,
    steps: def.steps.length,
    // 只有本地出片这一步吃显卡;剪拼、烧字幕、代码渲染(render_motion)没显卡也能跑
    needsLocalGpu: def.steps.some((s) => s.tool === 'generate_video'),
    updatedAt: def.updatedAt ?? null,
  };
}
