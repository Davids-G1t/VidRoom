import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('没登录(401):提示用启动地址打开', async () => {
    mockFetch({ '/api/status': { status: 401, body: { error: 'unauthorized' } } });
    render(<App />);
    expect(await screen.findByTestId('unauthorized-notice')).toBeInTheDocument();
    expect(screen.getByTestId('preset-workflows')).toBeVisible();
  });
});
