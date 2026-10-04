/** runner:取值、覆盖、each 展开、只跑认得的工具。 */
import { describe, expect, it } from 'vitest';
import type { LibraryWorkflow } from '../src/library.js';
import {
  describeSteps,
  readGenerateArgs,
  resolveValue,
  runWorkflow,
  type GenerateArgs,
  type RunScope,
} from '../src/runner.js';

function workflow(steps: LibraryWorkflow['steps'], slug = 'test'): LibraryWorkflow {
  return { slug, title: '测试', description: '', builtin: false, steps, text: '' };
}

/** 记下每次被调用的参数,返回可预测的产物。 */
function recorder(): {
  calls: GenerateArgs[];
  generate: (args: GenerateArgs) => Promise<{ promptId: string; url: string; filename: string }>;
} {
  const calls: GenerateArgs[] = [];
  return {
    calls,
    generate: async (args) => {
      calls.push(args);
      const index = calls.length;
      return { promptId: `p${index}`, url: `http://comfy/view?f=${index}.mp4`, filename: `${index}.mp4` };
    },
  };
}

describe('runner', () => {
  it('{{topic}} 填进去;整串是占位符时保留原类型', () => {
    const scope: RunScope = { topic: '一只猫', steps: {} };
    expect(resolveValue('{{topic}}', scope, 'x')).toBe('一只猫');
    expect(resolveValue('画:{{topic}}', scope, 'x')).toBe('画:一只猫');
    expect(resolveValue(7, scope, 'x')).toBe(7);
    expect(resolveValue('{{step.ids}}', { topic: '', steps: { step: { ids: [1, 2] } } }, 'x')).toEqual([1, 2]);
  });

  it('引用前面步骤的产物;取不到就报错', () => {
    const scope: RunScope = {
      topic: '',
      steps: { first: { id: 'p1', ids: ['p1'], url: 'http://comfy/view?f=1.mp4' } },
    };
    expect(resolveValue('{{first.id}}', scope, 'x')).toBe('p1');
    expect(resolveValue('重跑 {{first.ids}}', scope, 'x')).toBe('重跑 p1');
    expect(() => resolveValue('{{second.id}}', scope, 'x')).toThrow(/x:取不到 \{\{second.id\}\}/);
    expect(() => resolveValue('{{first.nope}}', scope, 'x')).toThrow(/x:取不到 \{\{first.nope\}\}/);
  });

  it('出片参数:缺项给默认值,空提示词报错', () => {
    const args = readGenerateArgs({ prompt: '{{topic}}' }, { topic: '一只猫', steps: {} }, 'x');
    expect(args).toEqual({ prompt: '一只猫', seconds: 5, megapixels: 0.4, aspect: '16:9' });
    expect(() => readGenerateArgs({ prompt: '' }, { topic: '', steps: {} }, 'x')).toThrow(/x:prompt 是空的/);
  });

  it('跑一份工作流:步骤的参数按序传给 generate', async () => {
    const { calls, generate } = recorder();
    const { results, steps } = await runWorkflow(
      workflow([
        {
          id: 'video',
          tool: 'generate_video',
          args: { prompt: '画 {{topic}}', seconds: 7, megapixels: 0.7, aspect: '9:16' },
        },
      ]),
      { topic: '一只猫' },
      generate,
    );
    expect(calls).toEqual([{ prompt: '画 一只猫', seconds: 7, megapixels: 0.7, aspect: '9:16' }]);
    expect(results.length).toBe(1);
    expect((steps['video'] as { id: string }).id).toBe('p1');
  });

  it('覆盖值压过工作流里写死的同名参数', async () => {
    const { calls, generate } = recorder();
    await runWorkflow(
      workflow([
        {
          id: 'video',
          tool: 'generate_video',
          args: { prompt: '{{topic}}', seconds: 5, megapixels: 0.4, aspect: '16:9' },
        },
      ]),
      { topic: '一只猫', overrides: { seconds: 7, megapixels: 0.7 } },
      generate,
    );
    expect(calls[0]).toEqual({ prompt: '一只猫', seconds: 7, megapixels: 0.7, aspect: '16:9' });
  });

  it('each 按上一步的数组展开,{{item.*}} 可用', async () => {
    const { calls, generate } = recorder();
    const two = workflow([
      { id: 'first', tool: 'generate_video', args: { prompt: '{{topic}}' } },
      { id: 'second', tool: 'generate_video', args: { prompt: '接着画 {{item.filename}}' }, each: '{{first.outputs}}' },
    ]);
    const { results } = await runWorkflow(two, { topic: '一只猫' }, generate);
    expect(results.length).toBe(2); // 第一步 1 个产物;第二步按这份产物展开跑 1 次
    expect(calls[0]?.prompt).toBe('一只猫');
    expect(calls[1]?.prompt).toBe('接着画 1.mp4');
  });

  it('不支持的工具、each 不是数组都报错;空工作流不报错但没有产物', async () => {
    const { generate } = recorder();
    await expect(
      runWorkflow(workflow([{ id: 'a', tool: 'upscale', args: { prompt: 'x' } }]), { topic: 't' }, generate),
    ).rejects.toThrow(/本批只支持 generate_video/);
    await expect(
      runWorkflow(
        workflow([{ id: 'a', tool: 'generate_video', args: { prompt: 'x' }, each: '{{topic}}' }]),
        { topic: 't' },
        generate,
      ),
    ).rejects.toThrow(/each 要解析成数组/);
    const empty = await runWorkflow(workflow([]), { topic: 't' }, generate);
    expect(empty.results).toEqual([]);
  });

  it('步骤摘要给面板看', () => {
    expect(
      describeSteps([
        { id: 'a', tool: 'generate_video', args: {} },
        { id: 'b', tool: 'generate_video', args: {}, each: '{{a.ids}}' },
      ]),
    ).toEqual(['generate_video', 'generate_video × each({{a.ids}})']);
  });
});
