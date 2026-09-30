import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

function mockFetch(routes: Record<string, { status: number; body: unknown }>) {
  const fn = vi.fn(async (url: string) => {
    const r = routes[url];
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('聊天页', () => {
  it('没有 key:提示去设置,预设工作流入口仍可见,输入框禁用', async () => {
    mockFetch({ '/api/status': { status: 200, body: { hasApiKey: false } } });
    render(<App />);
    expect(await screen.findByTestId('no-key-notice')).toHaveTextContent('去设置');
    expect(screen.getByTestId('preset-workflows')).toBeVisible();
    expect(screen.getByRole('button', { name: '文字生成视频' })).toBeEnabled();
    expect(screen.getByLabelText('输入消息')).toBeDisabled();
  });

  it('有 key:发消息后显示回答与工具调用摘要', async () => {
    mockFetch({
      '/api/status': { status: 200, body: { hasApiKey: true } },
      '/api/chat': {
        status: 200,
        body: {
          text: '你的显卡是 NVIDIA GeForce RTX 4060 Ti,16GB。',
          toolCalls: [{ toolName: 'probe_gpu', input: {}, output: { tier: 'experimental' } }],
        },
      },
    });
    render(<App />);
    const box = await screen.findByLabelText('输入消息');
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.change(box, { target: { value: '我这台电脑能跑什么' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByTestId('message-assistant')).toHaveTextContent('RTX 4060 Ti');
    expect(screen.getByText('调用了工具:probe_gpu')).toBeInTheDocument();
    expect(screen.queryByTestId('no-key-notice')).toBeNull();
  });

  it('桌面版设置页:存 key 后刷新状态、清空输入框,页面不显示 key', async () => {
    let hasKey = false;
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ hasApiKey: hasKey }), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const setKey = vi.fn(async () => {
      hasKey = true;
      return { ok: true as const };
    });
    vi.stubGlobal('vidroom', { getKeyStatus: async () => ({ configured: false }), setKey });

    render(<App />);
    fireEvent.click(within(await screen.findByTestId('no-key-notice')).getByRole('link', { name: '去设置' }));
    expect(await screen.findByTestId('key-status')).toHaveTextContent('未配置');
    const input = screen.getByLabelText('DeepSeek API key');
    fireEvent.change(input, { target: { value: '  sk-fake-123  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByTestId('settings-message')).toHaveTextContent('已保存');
    expect(setKey).toHaveBeenCalledWith('  sk-fake-123  ');
    expect(screen.getByTestId('key-status')).toHaveTextContent('已配置');
    expect(input).toHaveValue('');
    await waitFor(() => expect(screen.queryByTestId('no-key-notice')).toBeNull());
    expect(document.body.innerHTML).not.toContain('sk-fake-123');
  });

  it('浏览器里打开(没有桌面接口):设置页说明只在桌面版可用', async () => {
    mockFetch({ '/api/status': { status: 200, body: { hasApiKey: false } } });
    render(<App />);
    fireEvent.click(within(await screen.findByTestId('no-key-notice')).getByRole('link', { name: '去设置' }));
    expect(await screen.findByTestId('settings')).toHaveTextContent('只在桌面版里可用');
  });

  it('没登录(401):提示用启动地址打开', async () => {
    mockFetch({ '/api/status': { status: 401, body: { error: 'unauthorized' } } });
    render(<App />);
    expect(await screen.findByTestId('unauthorized-notice')).toBeInTheDocument();
    expect(screen.getByTestId('preset-workflows')).toBeVisible();
  });
});
