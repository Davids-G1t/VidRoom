/** 工作流库:SKILL.md 解析、列目录、读原文。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SkillParseError, getWorkflow, listWorkflows, parseSkill } from '../src/library.js';
import { workflowsRoot } from '../src/paths.js';

function skillText(slug: string): string {
  return readFileSync(`${workflowsRoot()}${slug}/SKILL.md`, 'utf8');
}

describe('工作流库', () => {
  it('内置工作流都在,且按 slug 排序', () => {
    const workflows = listWorkflows();
    expect(workflows.map((workflow) => workflow.slug)).toEqual(['h3-t2v', 'h3-t2v-vertical']);
    for (const workflow of workflows) {
      expect(workflow.builtin).toBe(true);
      expect(workflow.steps.length).toBe(1);
      expect(workflow.steps[0]?.tool).toBe('generate_video');
      expect(workflow.text, `${workflow.slug} 的原文里要有 steps 那段`).toContain('```workflow');
    }
  });

  it('解析真 SKILL.md:步骤字段逐项对得上', () => {
    const parsed = parseSkill(skillText('h3-t2v'), 'workflows/h3-t2v/SKILL.md');
    expect(parsed.title).toBe('主题直出(横屏 16:9)');
    expect(parsed.builtin).toBe(true);
    expect(parsed.steps).toEqual([
      {
        id: 'video',
        tool: 'generate_video',
        args: { prompt: '{{topic}}', seconds: 5, megapixels: 0.4, aspect: '16:9' },
      },
    ]);
  });

  it('格式不对就报错并给出来源,不猜', () => {
    expect(() => parseSkill('# 没有 frontmatter', 'x/SKILL.md')).toThrow(/x\/SKILL\.md:SKILL\.md 必须以 --- 开头/);
    expect(() => parseSkill('---\nname: a\n', 'x/SKILL.md')).toThrow(/frontmatter 没有收尾/);
    expect(() => parseSkill('---\ntitle: 没有 name\n---\n```workflow\n```\n', 'x/SKILL.md')).toThrow(/缺 name/);
    expect(() => parseSkill('---\nname: a\n---\n正文', 'x/SKILL.md')).toThrow(/找不到 ```workflow 代码块/);
  });

  it('steps 里出现不认识的字段/缺 tool 就报错', () => {
    const unknown =
      '---\nname: a\n---\n```workflow\nsteps:\n  - id: one\n    tool: generate_video\n    retry: 3\n```\n';
    expect(() => parseSkill(unknown, 'x/SKILL.md')).toThrow(/步骤 one 上有不认识的字段 retry/);
    const noTool = '---\nname: a\n---\n```workflow\nsteps:\n  - id: one\n    args: { prompt: "hi" }\n```\n';
    expect(() => parseSkill(noTool, 'x/SKILL.md')).toThrow(/步骤 one 没有 tool/);
    const noSteps = '---\nname: a\n---\n```workflow\nsteps:\n```\n';
    expect(() => parseSkill(noSteps, 'x/SKILL.md')).toThrow(/没有解析出任何步骤/);
  });

  it('解析错误是 SkillParseError', () => {
    expect(() => parseSkill('---\nname: a\n---\n```workflow\n  - id: one\n```\n', 'x/SKILL.md')).toThrow(
      SkillParseError,
    );
  });

  it('getWorkflow:读得到就是原文,读不到就 undefined,不做路径穿越', () => {
    const workflow = getWorkflow('h3-t2v');
    expect(workflow?.slug).toBe('h3-t2v');
    expect(workflow?.text).toBe(skillText('h3-t2v'));
    expect(getWorkflow('没有这份')).toBeUndefined();
    expect(getWorkflow('../secrets')).toBeUndefined();
    expect(getWorkflow('H3-T2V')).toBeUndefined();
  });
});
