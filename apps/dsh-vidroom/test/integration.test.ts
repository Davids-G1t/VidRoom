/**
 * 集成:钉住「提交 → 产出」这条链。
 *
 * 假 ComfyUI 充当那块 GPU,插件这一侧(routes / runtime / 客户端 / 工具)全是真的。
 * 钉住的是这批发货时的验收点:面板点一次运行,ComfyUI 真的收到了一个**符合请求**的任务
 * (7 秒 → 175 帧、0.7MP 16:9 → 1152x640),并且产物地址能取回字节。
 * 把 runtime.generate 里的 queue() 去掉、或让面板不走 startRun,这组断言就会红。
 */
import { expect, it } from 'vitest';
import { createVidroomRuntime } from '../src/runtime.js';
import { mountVidroomRoutes } from '../src/routes.js';
import { registerVidroomTools, type HostContext } from '../src/tools.js';
import { startFakeComfy } from './support/fake-comfy.js';
import { startTestWebServer } from './support/fake-web-server.js';

interface PanelRun {
  id: string;
  status: 'running' | 'success' | 'error';
  error?: string;
  promptIds: string[];
  media: Array<{ kind: string; url: string; filename: string }>;
}

/** 轮询面板那条运行记录,直到终态。 */
async function waitForRun(baseUrl: string, id: string): Promise<PanelRun> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const payload = (await (await fetch(`${baseUrl}/vidroom/run?id=${encodeURIComponent(id)}`)).json()) as {
      run: PanelRun;
    };
    if (payload.run.status !== 'running') return payload.run;
    if (Date.now() > deadline) throw new Error(`等 ${id} 超时,还停在 ${payload.run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 收集工具定义的最小宿主 Context。 */
function captureTools(): { ctx: HostContext; definitions: Map<string, Record<string, unknown>> } {
  const definitions = new Map<string, Record<string, unknown>>();
  const ctx: HostContext = {
    tools: {
      register(definition: unknown) {
        const record = definition as Record<string, unknown>;
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
  return { ctx, definitions };
}

it('面板运行:请求 7 秒 0.7MP → ComfyUI 收到 175 帧 1152x640 → 产物地址可取回', async () => {
  const comfy = await startFakeComfy({ historyMisses: 2 });
  const web = await startTestWebServer();
  const runtime = createVidroomRuntime({
    baseUrl: comfy.baseUrl,
    timeoutMs: 20_000,
    pollIntervalMs: 10,
    allowExperimental: false,
  });
  const disposers = mountVidroomRoutes({ webServer: web.service }, runtime);

  try {
    // ① 面板点「运行」:立刻拿到一条运行记录,不等出片。
    const started = await fetch(`${web.baseUrl}/vidroom/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'h3-t2v',
        topic: '一只猫在屋顶看日落',
        seconds: 7,
        megapixels: 0.7,
        aspect: '16:9',
      }),
    });
    expect(started.status).toBe(200);
    const { run } = (await started.json()) as { run: PanelRun };
    expect(run.status).toBe('running');

    // ② 轮询到终态:产物真的回来了。
    const finished = await waitForRun(web.baseUrl, run.id);
    expect(finished.error).toBeUndefined();
    expect(finished.status).toBe('success');
    expect(finished.promptIds).toEqual(['fake-1']);
    expect(finished.media[0]?.filename).toBe('h3_00001.mp4');
    expect(finished.media[0]?.kind).toBe('video');

    // ③ 提交给 ComfyUI 的图就是请求的形态(这条是「提交 → 产出」链的铆钉)。
    expect(comfy.submissions.length).toBe(1);
    const inputs = comfy.submissions[0]?.['140:131']?.inputs ?? {};
    expect(inputs.length).toBe(175);
    expect(inputs.width).toBe(1152);
    expect(inputs.height).toBe(640);
    expect(inputs.prompt).toBe('一只猫在屋顶看日落');
    expect(comfy.bodies[0]?.extra_data?.extra_pnginfo?.['comment']).toBe('AI-generated with MiniMax H3');

    // ④ 产物地址真能取回字节(播放器要的那一步)。
    const media = await fetch(finished.media[0]?.url ?? '');
    expect(media.status).toBe(200);
    expect((await media.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // ⑤ 工作流库面板的两条数据:列表 + SKILL.md 原文。
    const list = (await (await fetch(`${web.baseUrl}/vidroom/workflows`)).json()) as {
      workflows: Array<{ slug: string; steps: string[] }>;
      env: { reachable: boolean; vramTotalGiB?: number };
    };
    expect(list.workflows.map((workflow) => workflow.slug)).toEqual(['h3-t2v', 'h3-t2v-vertical']);
    expect(list.env.reachable).toBe(true);
    expect(list.env.vramTotalGiB).toBe(24);

    const read = (await (await fetch(`${web.baseUrl}/vidroom/workflow?slug=h3-t2v`)).json()) as {
      workflow: { text: string };
    };
    expect(read.workflow.text).toMatch(/```workflow/);
    expect(read.workflow.text).toMatch(/- id: video/);
  } finally {
    for (const dispose of disposers) dispose();
    await comfy.close();
    await web.close();
  }
});

it('工具直出:vidroom_generate → ComfyUI 提交 → 返回可播的地址', async () => {
  const comfy = await startFakeComfy();
  const runtime = createVidroomRuntime({
    baseUrl: comfy.baseUrl,
    timeoutMs: 20_000,
    pollIntervalMs: 10,
    allowExperimental: false,
  });
  const { ctx, definitions } = captureTools();
  const disposers = registerVidroomTools(ctx, runtime);

  try {
    const generate = definitions.get('vidroom_generate');
    expect(generate, 'vidroom_generate 没注册上').toBeDefined();
    const execute = generate?.execute as (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

    const value = await execute({ prompt: '一只猫在屋顶看日落', seconds: 7, megapixels: 0.7, aspect: '16:9' });
    expect(value.kind).toBe('sync');
    expect(value.promptId).toBe('fake-1');
    expect((value.actual as { frames: number }).frames).toBe(175);
    expect((value.actual as { width: number }).width).toBe(1152);
    expect((value.actual as { height: number }).height).toBe(640);
    expect((value.media as Array<{ url: string }>)[0]?.url).toBe(
      `${comfy.baseUrl}/view?filename=h3_00001.mp4&subfolder=&type=output`,
    );

    // render 给模型的那段文字要带上播放地址。
    const render = generate?.output as { render: (args: unknown, value: unknown) => Array<{ text: string }> };
    expect(render.render({}, value)[0]?.text).toMatch(/fake-1/);
    expect(render.render({}, value)[0]?.text).toMatch(/\/view\?/);
  } finally {
    for (const dispose of disposers) dispose();
    await comfy.close();
  }
});

it('工作流库工具:list / read / run,面板之外也走得通', async () => {
  const comfy = await startFakeComfy();
  const runtime = createVidroomRuntime({
    baseUrl: comfy.baseUrl,
    timeoutMs: 20_000,
    pollIntervalMs: 10,
    allowExperimental: false,
  });
  const { ctx, definitions } = captureTools();
  const disposers = registerVidroomTools(ctx, runtime);

  try {
    const workflows = definitions.get('vidroom_workflows');
    expect(workflows, 'vidroom_workflows 没注册上').toBeDefined();
    const execute = workflows?.execute as (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

    const listed = await execute({ action: 'list' });
    expect(listed.kind).toBe('list');
    expect((listed.workflows as unknown[]).length).toBe(2);
    expect((listed.env as { reachable: boolean }).reachable).toBe(true);

    const read = await execute({ action: 'read', slug: 'h3-t2v' });
    expect(read.kind).toBe('text');
    expect(String(read.text)).toMatch(/```workflow/);

    // run 不给覆盖值 → 用 SKILL.md 里写死的 5 秒 0.4MP:124 帧、864x480。
    await execute({ action: 'run', slug: 'h3-t2v', topic: '一只猫' });
    const defaults = comfy.submissions[0]?.['140:131']?.inputs ?? {};
    expect(defaults.length).toBe(124);
    expect(defaults.width).toBe(864);
    expect(defaults.height).toBe(480);

    // run 给覆盖值 → 覆盖工作流里写死的同名参数。
    await execute({ action: 'run', slug: 'h3-t2v', topic: '一只猫', seconds: 7, megapixels: 0.7 });
    const overridden = comfy.submissions[1]?.['140:131']?.inputs ?? {};
    expect(overridden.length).toBe(175);
    expect(overridden.width).toBe(1152);

    await expect(execute({ action: 'run', slug: 'h3-t2v' })).rejects.toThrow(/要给 topic/);
    await expect(execute({ action: 'read', slug: '不存在的' })).rejects.toThrow(/没有 不存在的 这份工作流/);
  } finally {
    for (const dispose of disposers) dispose();
    await comfy.close();
  }
});

it('ComfyUI 那边失败时,面板那条记录落到 error 并带上原因', async () => {
  const comfy = await startFakeComfy({ fail: true });
  const web = await startTestWebServer();
  const runtime = createVidroomRuntime({
    baseUrl: comfy.baseUrl,
    timeoutMs: 20_000,
    pollIntervalMs: 10,
    allowExperimental: false,
  });
  const disposers = mountVidroomRoutes({ webServer: web.service }, runtime);

  try {
    const started = await fetch(`${web.baseUrl}/vidroom/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'h3-t2v', topic: '一只猫' }),
    });
    const { run } = (await started.json()) as { run: PanelRun };
    const finished = await waitForRun(web.baseUrl, run.id);
    expect(finished.status).toBe('error');
    expect(finished.error ?? '').toMatch(/CUDA out of memory/);
  } finally {
    for (const dispose of disposers) dispose();
    await comfy.close();
    await web.close();
  }
});
