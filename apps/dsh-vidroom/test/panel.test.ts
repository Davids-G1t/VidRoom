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
