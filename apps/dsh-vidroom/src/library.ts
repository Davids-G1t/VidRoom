/**
 * 工作流库。一个工作流 = 目录 + 一份 `SKILL.md`:给人看的是 Markdown,
 * 给插件跑的是同一文件里那段窄 `workflow` steps(VidRoom 的老格式,继续沿用)。
 *
 * 这里只解析插件支持的窄 DSL,不引 YAML 依赖 —— 步骤字段就四个
 * (id / tool / args / each),解析器逐行读,不认识的行直接报错并给出行号,
 * 不猜。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { workflowsRoot } from './paths.js';

/** 一段工作流里的一个步骤。 */
export interface WorkflowStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** 展开表达式,必须解析成数组;展开时 `{{item.<字段>}}` 可用。 */
  each?: string;
}

/** 库里的一份工作流。 */
export interface LibraryWorkflow {
  /** 目录名,等于 frontmatter 的 name。 */
  slug: string;
  title: string;
  description: string;
  builtin: boolean;
  steps: WorkflowStep[];
  /** SKILL.md 原文(面板里"打开原文"看的就是这份)。 */
  text: string;
}

export class SkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillParseError';
  }
}

/** 拆出 frontmatter 与正文。 */
function splitFrontmatter(text: string, source: string): { frontmatter: string; body: string } {
  if (!text.startsWith('---')) throw new SkillParseError(`${source}:SKILL.md 必须以 --- 开头的 frontmatter 起手`);
  const end = text.indexOf('\n---', 3);
  if (end < 0) throw new SkillParseError(`${source}:frontmatter 没有收尾的 ---`);
  return { frontmatter: text.slice(text.indexOf('\n') + 1, end), body: text.slice(end + 4) };
}

/** frontmatter 的 `key: value` 逐行读(值是裸串或带引号)。 */
function parseFrontmatter(raw: string, source: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) throw new SkillParseError(`${source}:frontmatter 这行读不懂 —— ${trimmed}`);
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    fields[key] = value;
  }
  return fields;
}

/** 窄 DSL 的行内映射 `{ k: v, k2: "v2" }`。 */
function parseFlowMap(raw: string): Record<string, unknown> {
  const body = raw.trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  const args: Record<string, unknown> = {};
  if (body === '') return args;
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const char of body) {
    if (quote !== undefined) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  for (const part of parts) {
    const colon = part.indexOf(':');
    if (colon < 0) throw new SkillParseError(`args 里这段读不懂 —— ${part.trim()}`);
    const key = part.slice(0, colon).trim();
    const rawValue = part.slice(colon + 1).trim();
    args[key] = parseScalar(rawValue);
  }
  return args;
}

/** 标量:带引号 → 字符串;true/false → 布尔;数字 → 数;**裸串里出现 {{…}} 时保留成字符串**(留给 runner 填空)。 */
function parseScalar(raw: string): unknown {
  if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/** 解析一段 steps 块。 */
function parseSteps(block: string, source: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  let current: { id?: string; tool?: string; args?: Record<string, unknown>; each?: string; line: number } | undefined;
  const lines = block.split('\n');
  const flush = (): void => {
    if (current === undefined) return;
    if (current.id === undefined) throw new SkillParseError(`${source}:第 ${current.line} 行的步骤没有 id`);
    if (current.tool === undefined) throw new SkillParseError(`${source}:步骤 ${current.id} 没有 tool`);
    steps.push({
      id: current.id,
      tool: current.tool,
      args: current.args ?? {},
      ...(current.each === undefined ? {} : { each: current.each }),
    });
    current = undefined;
  };
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    const lineNumber = index + 1;
    if (line === '' || line.startsWith('#') || line === 'steps:') continue;
    const field = /^(?:-\s*)?([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (field === null) throw new SkillParseError(`${source}:steps 第 ${lineNumber} 行读不懂 —— ${line}`);
    const key = field[1] ?? '';
    const value = field[2] ?? '';
    if (key === 'id') {
      flush();
      current = { id: value.trim(), line: lineNumber };
      continue;
    }
    if (current === undefined)
      throw new SkillParseError(`${source}:steps 第 ${lineNumber} 行的 ${key} 不在任何 - id: 之下`);
    if (key === 'tool') current.tool = value.trim();
    else if (key === 'each') current.each = value.trim().replace(/^["']|["']$/g, '');
    else if (key === 'args') current.args = parseFlowMap(value);
    else throw new SkillParseError(`${source}:步骤 ${current.id} 上有不认识的字段 ${key}`);
  }
  flush();
  if (steps.length === 0) throw new SkillParseError(`${source}:没有解析出任何步骤`);
  return steps;
}

/** 解析一份 SKILL.md。给了 `expectedSlug`(目录名)就一并核「slug 必须等于 frontmatter 的 name」。 */
export function parseSkill(
  text: string,
  source = 'SKILL.md',
  expectedSlug?: string,
): Omit<LibraryWorkflow, 'slug' | 'text'> {
  const { frontmatter, body } = splitFrontmatter(text, source);
  const fields = parseFrontmatter(frontmatter, source);
  const name = fields.name ?? '';
  if (name === '') throw new SkillParseError(`${source}:frontmatter 缺 name`);
  if (expectedSlug !== undefined && name !== expectedSlug) {
    throw new SkillParseError(`${source}:frontmatter 的 name(${name})和目录名(${expectedSlug})对不上 —— slug 必须等于 name`);
  }
  const block = /```workflow\n([\s\S]*?)```/.exec(body);
  if (block === null) throw new SkillParseError(`${source}:找不到 \`\`\`workflow 代码块`);
  return {
    title: fields.title ?? name,
    description: fields.description ?? '',
    builtin: fields.builtin === 'true',
    steps: parseSteps(block[1] ?? '', source),
  };
}

/** 列目录下一份工作流(slug 必须是小写短横线格式,且等于 frontmatter 的 name)。 */
function readWorkflow(dir: string, slug: string): LibraryWorkflow {
  const file = join(dir, slug, 'SKILL.md');
  const text = readFileSync(file, 'utf8');
  const parsed = parseSkill(text, `workflows/${slug}/SKILL.md`, slug);
  return { slug, ...parsed, text };
}

/** 列仓库里全部内置工作流(按 slug 排序)。目录里读不出工作流的直接报错,不静默跳过。 */
export function listWorkflows(root: string = workflowsRoot()): LibraryWorkflow[] {
  const slugs = readdirSync(root)
    .filter((entry) => statSync(join(root, entry)).isDirectory())
    .sort();
  return slugs.map((slug) => readWorkflow(root, slug));
}

/** 取一份内置工作流;没有这个 slug 返回 undefined。 */
export function getWorkflow(slug: string, root: string = workflowsRoot()): LibraryWorkflow | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return undefined;
  try {
    return readWorkflow(root, slug);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
