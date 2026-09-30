import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComfyPanel } from '../src/ComfyPanel';

const RUNNING = { state: 'running', port: 43611, url: 'http://127.0.0.1:43611', devices: ['cpu'] };

function mockComfy(status: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(status), { status: 200 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('ComfyUI 面板', () => {
  it('未启动:只有「启动 ComfyUI」,点了发 POST /api/comfyui/start', async () => {
    const fn = mockComfy({ state: 'stopped' });
    render(<ComfyPanel />);
    expect(await screen.findByTestId('comfyui-status')).toHaveTextContent('未启动');
    expect(screen.queryByRole('button', { name: '打开 ComfyUI' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '启动 ComfyUI' }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalledWith('/api/comfyui/start', { method: 'POST' }));
  });

  it('浏览器里:点「打开 ComfyUI」新开 http://127.0.0.1:<端口>/', async () => {
    mockComfy(RUNNING);
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<ComfyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '打开 ComfyUI' }));
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:43611/', '_blank', 'noopener');
  });

  it('桌面版:交给主进程打开(页面不传地址)', async () => {
    mockComfy(RUNNING);
    const openComfyUI = vi.fn(async () => ({ ok: true as const, url: 'http://127.0.0.1:43611/' }));
    vi.stubGlobal('vidroom', { openComfyUI });
    render(<ComfyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '打开 ComfyUI' }));
    await vi.waitFor(() => expect(openComfyUI).toHaveBeenCalledWith());
  });
});
