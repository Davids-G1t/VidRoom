import { useEffect, useState } from 'react';
import { H3_NOTICE_PATH, USE_POLICY_URL, fetchText } from './api';

/** 「关于」页:VidRoom 自身许可 + 本地视频模型 MiniMax H3 的标名与 NOTICE 原文 */
export function About({ onClose, onReport }: { onClose: () => void; onReport: () => void }) {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    fetchText(H3_NOTICE_PATH).then((t) => setNotice(t?.trim() ?? null));
  }, []);

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-label="关于" data-testid="about">
        <h2>关于 VidRoom</h2>
        <p>VidRoom 是本地 AI 视频个人工坊,主程序以 Apache-2.0 许可开源。</p>
        <h2>
          本地视频模型:<span className="badge">MiniMax H3</span>
        </h2>
        <p>视频由 MiniMax 的 MiniMax H3 模型在你的电脑上生成,经 ComfyUI 运行。</p>
        <blockquote className="notice-text" data-testid="h3-notice">
          {notice ?? '正在加载 NOTICE…'}
        </blockquote>
        <ul>
          <li>
            <a href="/licenses/MiniMax-H3-LICENSE.txt" target="_blank" rel="noreferrer">
              MiniMax H3 Community License Agreement 全文
            </a>
          </li>
          <li>
            <a href={USE_POLICY_URL} target="_blank" rel="noreferrer">
              使用限制(许可第 V 节与附件 A)
            </a>
          </li>
        </ul>
        <div className="modal-actions">
          <button type="button" onClick={onReport}>
            举报滥用
          </button>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </section>
    </div>
  );
}
