import { useEffect, useState } from 'react';
import { acceptH3License, fetchH3, startH3Download, type DownloadState, type H3Status } from './api';
import { LicenseDialog } from './LicenseDialog';

function describeDownload(d: DownloadState): string {
  switch (d.state) {
    case 'idle':
      return '';
    case 'checking':
      return '正在核对已有的模型文件(第一次要算校验和,几十 GB 约需一分钟)…';
    case 'downloading':
      return `正在下载 ${d.file}:${(d.received / 2 ** 20).toFixed(0)} / ${(d.total / 2 ** 20).toFixed(0)} MiB`;
    case 'done':
      return d.downloaded.length ? `下载完成:${d.downloaded.join('、')}` : '模型文件都已就绪,不用下载。';
    case 'error':
      return `下载失败:${d.message}`;
  }
}

/**
 * 「出片」入口:第一次点先弹许可同意页;同意后补齐 MiniMax H3 的权重(已有且校验通过的跳过)。
 * 模型就绪后,在聊天里说想要什么视频,助手会调用 generate_video。
 */
export function H3Panel() {
  const [status, setStatus] = useState<H3Status | null>(null);
  const [dialog, setDialog] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const downloading = status?.download.state === 'checking' || status?.download.state === 'downloading';

  useEffect(() => {
    fetchH3().then(setStatus);
  }, []);

  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(async () => {
      const s = await fetchH3();
      if (!s) return;
      setStatus(s);
    }, 1000);
    return () => clearInterval(t);
  }, [downloading]);

  async function download() {
    setNotice(null);
    const d = await startH3Download();
    if (!d) return setNotice('没能开始下载,请重试。');
    setStatus((s) => (s ? { ...s, download: d } : s));
  }

  async function onClick() {
    const s = await fetchH3();
    setStatus(s);
    if (!s) return setNotice('连不上 VidRoom Host。');
    if (!s.consent) return setDialog(true);
    await download();
  }

  async function onAccept() {
    if (!status) return;
    setDialog(false);
    const r = await acceptH3License(status.license.sha256);
    if (!r) return setNotice('记录同意失败,请重试。');
    await download();
  }

  return (
    <section className="h3" data-testid="h3-panel" aria-label="MiniMax H3 出片">
      <div className="h3-row">
        <span className="badge">MiniMax H3</span>
        <button type="button" onClick={onClick} disabled={downloading}>
          出片
        </button>
        {status && (
          <span className="notice" data-testid="h3-admission">
            {status.admission.reason}
          </span>
        )}
      </div>
      {status?.consent && (
        <p className="notice" data-testid="h3-consent">
          已于 {new Date(status.consent.acceptedAt).toLocaleString()} 同意 MiniMax H3 许可
        </p>
      )}
      {status && status.download.state !== 'idle' && (
        <p className="notice" data-testid="h3-download">
          {describeDownload(status.download)}
        </p>
      )}
      {status?.download.state === 'done' && <p className="notice">模型就绪:在下面的聊天框里说说你想要什么视频。</p>}
      {notice && <p className="notice">{notice}</p>}
      {dialog && status && <LicenseDialog license={status.license} onAccept={onAccept} onClose={() => setDialog(false)} />}
    </section>
  );
}
