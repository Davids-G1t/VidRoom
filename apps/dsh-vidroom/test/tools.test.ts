/** 工具注册表:注册两个工具、参数校验、卸载。 */
import { describe, expect, it } from 'vitest';
import type { VidroomRuntime } from '../src/runtime.js';
import { registerVidroomTools, type HostContext } from '../src/tools.js';

/** 出片结果的最小替身:只填测试关心的字段。 */
function outcome(promptId = 'p1') {
  return {
    promptId,
    url: `http://comfy/view?filename=${promptId}.mp4`,
    filename: `${promptId}.mp4`,
    media: [
      {
        filename: `${promptId}.mp4`,
        subfolder: '',
        type: 'output',
        url: `http://comfy/view?filename=${promptId}.mp4`,
        kind: 'video' as const,
      },
    ],
    frames: 175,
    seconds: 175 / 24,
    width: 1152,
    height: 640,
    megapixels: 0.703,
    elapsedMs: 1000,
  };
}

function fakeRuntime(overrides: Partial<VidroomRuntime> = {}): VidroomRuntime {
  const runtime: VidroomRuntime = {
    config: () => ({ baseUrl: 'http://127.0.0.1:8188', timeoutMs: 1, pollIntervalMs: 1, allowExperimental: false }),
    client: () => ({}) as never,
    workflows: () => [],
    workflow: () => undefined,
    generate: async () => outcome(),
    runWorkflow: async () => ({ results: [], steps: {} }),
    startRun: () => {
      throw new Error('工具不该走面板那条路');
    },
    runs: { start: () => ({}) as never, get: () => undefined, update: () => {}, list: () => [] } as never,
    status: async () => ({
      baseUrl: 'http://127.0.0.1:8188',
      reachable: true,
      admission: { allowed: true, tier: 'default', reason: '显存够,默认开启' },
    }),
    ...overrides,
  };
  return runtime;
}

function capture(): { ctx: HostContext; definitions: Map<string, ToolLike>; names: () => string[] } {
  const definitions = new Map<string, ToolLike>();
  const ctx: HostContext = {
    tools: {
      register(definition: unknown) {
        const record = definition as ToolLike & { name: string };
        definitions.set(String(record.name), record);
        return () => definitions.delete(String(record.name));
      },
    },
    get: () => undefined,
    effect: (callback) => {
      callback();
    },
    inject: (_services, callback) => {
      callback({});
    },
  };
  return { ctx, definitions, names: () => [...definitions.keys()] };
}

interface ToolLike {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  output: {
    presentationMeta: (args: unknown, value: unknown) => Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ text: string }>;
  };
}

function tools(overrides: Partial<VidroomRuntime> = {}): { generate: ToolLike; workflows: ToolLike; names: () => string[] } {
  const { ctx, definitions, names } = capture();
  registerVidroomTools(ctx, fakeRuntime(overrides));
  return {
    generate: definitions.get('vidroom_generate') as ToolLike,
    workflows: definitions.get('vidroom_workflows') as ToolLike,
    names,
  };
}

describe('工具注册表', () => {
  it('注册两个工具,每个都给得出卸载函数', () => {
    const { ctx, names } = capture();
    const disposers = registerVidroomTools(ctx, fakeRuntime());
    expect(names()).toEqual(['vidroom_generate', 'vidroom_workflows']);
    expect(disposers.length).toBe(2);
    for (const dispose of disposers) dispose();
    expect(names()).toEqual([]);
  });

  it('vidroom_generate 要 prompt 或 topic,别名 topic 也认', async () => {
    const { generate } = tools();
    await expect(generate.execute({})).rejects.toThrow(/要给 prompt/);
    await expect(generate.execute({ prompt: '   ' })).rejects.toThrow(/要给 prompt/);
    const byTopic = await generate.execute({ topic: '一只猫' });
    expect(byTopic.promptId).toBe('p1');
    expect((byTopic.actual as { frames: number }).frames).toBe(175);
  });

  it('vidroom_generate 的参数默认值:5 秒 0.4MP 16:9', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { generate } = tools({
      generate: async (args) => {
        seen.push(args);
        return outcome();
      },
    });
    await generate.execute({ prompt: '一只猫' });
    expect(seen[0]).toEqual({ prompt: '一只猫', seconds: 5, megapixels: 0.4, aspect: '16:9' });
  });

  it('vidroom_generate 落成卡片数据:summary 与播放地址', async () => {
    const { generate } = tools();
    const value = await generate.execute({ prompt: '一只猫' });
    const meta = generate.output.presentationMeta({}, value);
    expect(meta.kind).toBe('sync');
    expect(meta.summary).toMatch(/1152x640 · 175 帧 · 7\.29 秒/);
    expect((meta.media as unknown[]).length).toBe(1);
    expect(generate.output.render({}, value)[0]?.text).toMatch(/\/view\?/);
  });

  it('action 不认识就报错;run 缺 slug/topic 也报错', async () => {
    const stub = { slug: 'h3-t2v', title: '主题直出', description: '', builtin: true, steps: [], text: '' };
    const { workflows } = tools({ workflow: (slug) => (slug === 'h3-t2v' ? stub : undefined) });
    await expect(workflows.execute({ action: 'nope' })).rejects.toThrow(/不认识 action nope/);
    await expect(workflows.execute({ action: 'run', slug: '没有这份', topic: 't' })).rejects.toThrow(
      /没有 没有这份 这份工作流/,
    );
    await expect(workflows.execute({ action: 'run', slug: 'h3-t2v' })).rejects.toThrow(/要给 topic/);
  });
});
