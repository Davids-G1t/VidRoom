// @vitest-environment jsdom
/**
 * 面板:列工作流 → 点开看 SKILL.md 原文 → 填主题点运行。
 *
 * 这层专门放真 DOM 里跑,因为这一块真崩过一次:点开工作流那块用了 `style: '…'` 字符串,
 * 而 React 只收对象 —— 点一下就抛 «The `style` prop expects a mapping…»,面板停在列表上,
 * 原文读不了、运行也点不了(第二轮审查抓到的 high)。所以这里除了「点得动」,
 * 还钉一条:面板里排版一律走 class,markup 里不许出现内联 style。
 */
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VidroomPanel } from '../src/client/panel.tsx';
import { panelStore } from '../src/client/store.ts';

const SKILL_TEXT = '# 主题直出(横屏 16:9)\n\n一句主题 → 一段 5 秒横屏短片(带声音)。\n';

const WORKFLOW = {
  slug: 'h3-t2v',
  title: '主题直出(横屏 16:9)',
  description: '一句主题 → 一段 5 秒 16:9 的 MiniMax H3 本地视频',
  builtin: true,
  steps: ['generate_video'],
  defaults: { seconds: 5, megapixels: 0.4, aspect: '16:9' },
};

interface Call {
  url: string;
  body?: unknown;
}

const calls: Call[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

/** 假宿主:面板要的四个接口都答,别的请求直接报出来(不静默)。 */
function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
  calls.push(body === undefined ? { url } : { url, body });
  if (url.startsWith('/vidroom/workflows')) {
    return Promise.resolve(
      jsonResponse({
        ok: true,
        workflows: [WORKFLOW],
        env: {
          baseUrl: 'http://127.0.0.1:8188',
          reachable: true,
          vramTotalGiB: 24,
          admission: { allowed: true, tier: 'ok', reason: '' },
        },
      }),
    );
  }
  if (url.startsWith('/vidroom/workflow?')) {
    return Promise.resolve(
      jsonResponse({ ok: true, workflow: { ...WORKFLOW, text: SKILL_TEXT } }),
    );
  }
  if (url.startsWith('/vidroom/run')) {
    return Promise.resolve(
      jsonResponse({
        ok: true,
        run: {
          id: 'run-1',
          slug: WORKFLOW.slug,
          title: WORKFLOW.title,
          topic: '一只猫在窗台上打盹',
          status: 'running',
          media: [],
        },
      }),
    );
  }
  return Promise.reject(new Error(`测试没准备这个请求:${url}`));
}

/** 等某个元素出现(面板是异步拉数据的),顺带把 React 的更新 flush 掉。 */
async function waitFor<T>(pick: () => T | null, what: string): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = pick();
    if (value !== null) return value;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`等不到${what}`);
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  panelStore.open();
  act(() => {
    root.render(h(VidroomPanel));
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  panelStore.close();
  vi.unstubAllGlobals();
});

describe('工作流库面板', () => {
  it('列得出来、点得开、看得到原文', async () => {
    const item = await waitFor(() => document.querySelector<HTMLButtonElement>('.dvr-item'), '工作流列表');
    expect(item.textContent).toContain(WORKFLOW.title);

    await act(async () => {
      item.click();
    });

    const skill = await waitFor(() => document.querySelector('.dvr-skill'), 'SKILL.md 原文');
    expect(skill.textContent).toContain('一句主题 → 一段 5 秒横屏短片');
    expect(document.querySelector('.dvr-detail'), '点开后的那块是 class,不是内联 style').not.toBeNull();
  });

  it('排版走 class:markup 里不带内联 style(字符串 style 会让 React 抛错)', async () => {
    const item = await waitFor(() => document.querySelector<HTMLButtonElement>('.dvr-item'), '工作流列表');
    await act(async () => {
      item.click();
    });
    await waitFor(() => document.querySelector('.dvr-skill'), 'SKILL.md 原文');

    expect(document.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('填一句主题点运行 → 真发 POST,并拿到运行记录', async () => {
    const item = await waitFor(() => document.querySelector<HTMLButtonElement>('.dvr-item'), '工作流列表');
    await act(async () => {
      item.click();
    });
    await waitFor(() => document.querySelector('.dvr-skill'), 'SKILL.md 原文');

    const textarea = await waitFor(() => document.querySelector<HTMLTextAreaElement>('.dvr-textarea'), '主题框');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '一只猫在窗台上打盹');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const runButton = [...document.querySelectorAll<HTMLButtonElement>('.dvr-btn')].find(
      (button) => button.textContent === '运行',
    );
    expect(runButton, '找不到运行按钮').toBeDefined();
    expect(runButton?.disabled, '填了主题就该能点').toBe(false);

    await act(async () => {
      runButton?.click();
    });

    const posted = calls.find((call) => call.url === '/vidroom/run');
    // 选中工作流时那份默认值(秒数/像素/长宽比)会一起带上 —— 这是有意的:确认过的值发出去,不留空。
    expect(posted?.body).toEqual({ slug: WORKFLOW.slug, topic: '一只猫在窗台上打盹', seconds: 5, megapixels: 0.4, aspect: '16:9' });
    const status = await waitFor(() => document.querySelector('.dvr-status--ok'), '运行状态');
    expect(status.textContent).toContain('跑着呢(run-1)');
  });
});

/**
 * 工程面板的写入口:这是「复刻一条爆款」在默认装法下的唯一通道。
 *
 * 工程面工具默认不注册(`config.chatTools`),所以面板只读 = 这条链在默认安装里走不通
 * (第三轮审查的 high)。这里钉住:从造工程到渲染这几步在面板上点得出来,
 * 而且请求打的是同一批本地路由。
 */
describe('工程面板(写入口)', () => {
  const PROJECT_DIR = '/tmp/vr/p1';
  const PLAN_HASH = '9'.repeat(64);
  const calls: Call[] = [];

  function projectFetch(input: string, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push(body === undefined ? { url } : { url, body });
    const view = {
      projectPath: PROJECT_DIR,
      projectFile: `${PROJECT_DIR}/project.vr.json`,
      projectId: 'p1',
      revision: 3,
      projectHash: 'a1b2c3d4',
      counts: { assets: 1, shots: 1, candidates: 1, selected: 0, alignments: 0, anchors: 0, captions: 0, effects: 0, variants: 0 },
      issues: [],
      alignmentIssues: [],
    };
    if (url.startsWith('/vidroom/workflows')) {
      return Promise.resolve(jsonResponse({ ok: true, workflows: [WORKFLOW], env: {} }));
    }
    if (url.startsWith('/vidroom/projects')) {
      return Promise.resolve(jsonResponse({ ok: true, root: '/tmp/vr', projects: [view] }));
    }
    if (url.startsWith('/vidroom/project?')) {
      return Promise.resolve(
        jsonResponse({ ok: true, project: view, candidates: [], missingAssets: [], runs: [], shots: [{ id: 'shot-1', order: 0, text: '第一段' }] }),
      );
    }
    if (url.startsWith('/vidroom/assets?')) {
      return Promise.resolve(
        jsonResponse({ ok: true, total: 1, items: [{ id: 'asset-1', kind: 'video', path: 'assets/a.mp4', sha256: 'f'.repeat(64), missing: false }] }),
      );
    }
    if (url.startsWith('/vidroom/plan?')) {
      return Promise.resolve(
        jsonResponse({
          ok: true,
          plan: {
            target: 'candidates',
            planHash: PLAN_HASH,
            projectHash: 'a1b2c3d4',
            ready: true,
            blockers: [],
            newRequests: 1,
            reuseCandidateIds: [],
            summary: '计划 999999999999(目标 candidates · 工程哈希 a1b2c3d4)',
          },
        }),
      );
    }
    if (url === '/vidroom/render') {
      return Promise.resolve(jsonResponse({ ok: true, runId: 'run-9', mode: 'generate-missing', job: {} }));
    }
    return Promise.reject(new Error(`测试没准备这个请求:${url}`));
  }

  it('造工程 → 算计划 → 按计划渲染,都能在面板上点出来,请求走同一条本地路由', async () => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(projectFetch));
    // beforeEach 那份实例是用「工作流面板」的假宿主渲染的,先摘掉 —— 不然下面查到的是那一份。
    act(() => {
      root.unmount();
    });
    host.remove();
    const ownHost = document.createElement('div');
    document.body.appendChild(ownHost);
    const ownRoot = createRoot(ownHost);
    act(() => {
      ownRoot.render(h(VidroomPanel));
    });

    try {
      // 每次都重新查一遍:面板会重渲染,抓着旧节点等会把结果看漏。
      const pickerOption = await waitFor(
        () => document.querySelector<HTMLOptionElement>('.dvr-form select.dvr-input option[value="/tmp/vr/p1"]'),
        '工程选项',
      );
      expect(pickerOption.textContent).toContain('p1');

      await act(async () => {
        const select = document.querySelector<HTMLSelectElement>('.dvr-form select.dvr-input');
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        setter?.call(select, PROJECT_DIR);
        select?.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const labels = await waitFor(() => {
        const texts = [...document.querySelectorAll<HTMLButtonElement>('.dvr-btn')].map((button) => button.textContent);
        return texts.includes('按这份计划渲染') ? texts : null;
      }, '写入口按钮');
      // 造工程 / 改工程 / 导素材 / 登记候选 / 校词窗 —— 一个都不能少,否则面板只能看不能改。
      for (const label of ['造工程', '应用改动', '导进来', '登记候选', '算候选计划', '按这份计划渲染', '校词窗']) {
        expect(labels).toContain(label);
      }

      const click = async (label: string): Promise<void> => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('.dvr-btn')].find(
          (item) => item.textContent === label,
        );
        expect(button, `找不到按钮 ${label}`).toBeDefined();
        await act(async () => {
          button?.click();
        });
      };

      await click('算候选计划');
      const planned = calls.find((call) => call.url.startsWith('/vidroom/plan?'));
      expect(planned?.url).toContain(`path=${encodeURIComponent(PROJECT_DIR)}`);
      expect(planned?.url).toContain('target=candidates');
      await waitFor(() => document.querySelector('.dvr-status--ok'), '计划结论');

      await click('按这份计划渲染');
      const rendered = calls.find((call) => call.url === '/vidroom/render');
      expect(rendered?.body).toMatchObject({
        path: PROJECT_DIR,
        mode: 'generate-missing',
        planHash: PLAN_HASH,
        expectedProjectHash: 'a1b2c3d4',
      });
    } finally {
      act(() => {
        ownRoot.unmount();
      });
      ownHost.remove();
    }
  });
});
