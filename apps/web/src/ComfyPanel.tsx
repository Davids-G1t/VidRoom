import { useEffect, useState } from 'react';
import { fetchComfy, startComfy, stopComfy, type ComfyStatus } from './api';
import { desktopApi } from './desktop';

function describe(s: ComfyStatus | null): string {
  if (s === null) return '状态未知';
  switch (s.state) {
    case 'stopped':
      return '未启动';
    case 'installing':
      return s.phase === 'extracting'
        ? '正在解压…'
        : `正在下载 ${((s.received ?? 0) / 2 ** 20).toFixed(0)} / ${((s.total ?? 0) / 2 ** 20).toFixed(0)} MiB`;
    case 'starting':
      return '正在启动…';
    case 'running':
      return `运行中(${s.devices.join('、') || '设备未知'})`;
    case 'error':
      return `出错:${s.message.split('\n')[0]}`;
  }
}

/** 高级用户入口:起停 ComfyUI、在系统浏览器里打开它自己的网页(只在 127.0.0.1 上) */
export function ComfyPanel() {
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = status?.state === 'installing' || status?.state === 'starting';

  useEffect(() => {
    fetchComfy().then(setStatus);
  }, []);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => fetchComfy().then(setStatus), 1000);
    return () => clearInterval(t);
  }, [busy]);

  async function open() {
    setNotice(null);
    const api = desktopApi();
    if (api) {
      const r = await api.openComfyUI();
      if (!r.ok) setNotice(r.message);
    } else if (status?.state === 'running') {
      window.open(`${status.url}/`, '_blank', 'noopener');
    }
  }

  return (
    <section className="comfy" data-testid="comfyui-panel" aria-label="ComfyUI">
      <span>
        ComfyUI:<span data-testid="comfyui-status">{describe(status)}</span>
      </span>
      {status?.state === 'running' ? (
        <>
          <button type="button" onClick={open}>
            打开 ComfyUI
          </button>
          <button type="button" onClick={() => stopComfy().then(setStatus)}>
            停止
          </button>
        </>
      ) : (
        <button type="button" disabled={busy} onClick={() => startComfy().then((s) => s && setStatus(s))}>
          启动 ComfyUI
        </button>
      )}
      {notice && <span className="notice">{notice}</span>}
    </section>
  );
}
