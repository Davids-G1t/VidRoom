import { mkdirSync, rmSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_SKILL } from '../src/workflows/default.js';
import { WorkflowNoKeyError, WorkflowRunner } from '../src/workflows/runner.js';
import { WorkflowService } from '../src/workflows/service.js';
import { parseSkill, workflowToSkillSource } from '../src/workflows/skill.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function testDir(name: string): string {
  const root = join(process.cwd(), '.test-tmp', name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function jsonModel(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] }),
  });
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('工作流 SKILL.md', () => {
  it('解析默认工作流,并能回写往返', () => {
    const def = parseSkill(DEFAULT_WORKFLOW_SKILL, 'topic-to-video');
    expect(def.title).toBe('默认工作流');
    expect(def.steps.map((s) => s.tool)).toEqual(['write_script', 'generate_video', 'concat_videos', 'add_subtitle']);
    expect(def.steps[1]).toMatchObject({ each: '{{script.shots}}', args: { seconds: 3 } });

    const source = workflowToSkillSource({ name: 'custom-flow', title: '自定义', description: '测试', steps: def.steps });
    expect(parseSkill(source, 'custom-flow').steps).toEqual(def.steps);
  });

  it('缺 frontmatter 或坏 steps 会报错', () => {
    expect(() => parseSkill('# no front')).toThrow(/frontmatter/);
    expect(() => parseSkill('---\nname: bad\ntitle: 坏\ndescription: 坏\n---\n```workflow\nnope:\n```')).toThrow(/steps/);
  });
});

describe('工作流 runner', () => {
  it('按顺序执行、解析三种取值、each 聚合 ids、失败即停', async () => {
    const def = parseSkill(DEFAULT_WORKFLOW_SKILL, 'topic-to-video');
    const calls: Array<[string, unknown]> = [];
    let n = 0;
    const video = {
      generate: async (input: { prompt: string; seconds: number }) => {
        calls.push(['generate_video', input]);
        n += 1;
        return { ok: true, video: { id: `shot-${n}`, seconds: input.seconds } };
      },
    } as any;
    const editor = {
      concat: async (ids: string[]) => {
        calls.push(['concat_videos', ids]);
        return { ok: true, video: { id: 'joined' } };
      },
      subtitle: async (id: string, text: string) => {
        calls.push(['add_subtitle', { id, text }]);
        return { ok: true, video: { id: 'final' } };
      },
      list: async () => [],
    } as any;
    const script = JSON.stringify({ caption: '晚安橘猫', shots: [{ prompt: 'one' }, { prompt: 'two' }, { prompt: 'three' }] });
    const runner = new WorkflowRunner(def, { model: jsonModel(script), tools: { video, editor } });
    const result = await runner.run('橘猫主题');

    expect(calls).toEqual([
      ['generate_video', { prompt: 'one', seconds: 3 }],
      ['generate_video', { prompt: 'two', seconds: 3 }],
      ['generate_video', { prompt: 'three', seconds: 3 }],
      ['concat_videos', ['shot-1', 'shot-2', 'shot-3']],
      ['add_subtitle', { id: 'joined', text: '晚安橘猫' }],
    ]);
    expect(result.final).toMatchObject({ id: 'final' });

    const badEditor = { ...editor, concat: async () => ({ ok: false, reason: 'concat failed' }) } as any;
    await expect(new WorkflowRunner(def, { model: jsonModel(script), tools: { video, editor: badEditor } }).run('x')).rejects.toThrow('concat failed');
  });

  it('没有模型时 write_script fail-closed', async () => {
    const def = parseSkill(DEFAULT_WORKFLOW_SKILL, 'topic-to-video');
    await expect(new WorkflowRunner(def, { model: null, tools: {} }).run('主题')).rejects.toBeInstanceOf(WorkflowNoKeyError);
  });
});

describe('WorkflowService', () => {
  it('没有 key 时只拦含 write_script 的工作流,纯剪辑工作流照跑', async () => {
    const root = testDir('workflow-service-nokey');
    dirs.push(root);
    const service = new WorkflowService(root, null, { editor: { list: async () => [] } } as never);
    await service.saveWorkflow({ name: 'clip-only', title: '纯剪辑', description: '不需要 LLM', steps: [{ id: 'only', tool: 'list_videos', args: {} }] });

    expect((await service.startRun('clip-only', '主题')).state).toBe('running');
    await service.waitForIdle();
    expect((await service.job()).state).toBe('done');

    await expect(service.startRun('topic-to-video', '主题')).rejects.toBeInstanceOf(WorkflowNoKeyError);
  });

  it('物化默认 SKILL.md,save_workflow 真写文件,source 拒绝坏内容', async () => {
    const root = testDir('workflow-service');
    dirs.push(root);
    const service = new WorkflowService(root, jsonModel('{"caption":"c","shots":[{"prompt":"p"}]}'), {});
    expect((await service.list()).map((w) => w.id)).toContain('topic-to-video');

    const saved = await service.saveWorkflow({
      name: 'saved-flow',
      title: '保存的流程',
      description: '保存测试',
      steps: [{ id: 'only', tool: 'list_videos', args: {} }],
    });
    expect(existsSync(saved.path)).toBe(true);
    expect(readFileSync(saved.path, 'utf8')).toContain('name: saved-flow');
    await expect(service.saveSource('saved-flow', 'bad')).rejects.toThrow(/frontmatter/);
  });
});
