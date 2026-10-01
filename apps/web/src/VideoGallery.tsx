import { useState } from 'react';
import { videoFileUrl, type VideoRecord } from './api';

const mib = (v: number | null) => (v === null ? '未知' : `${(v / 1024).toFixed(1)} GiB`);
const isCode = (v: VideoRecord) => v.model === 'HyperFrames';
const badge = (v: VideoRecord) => (isCode(v) ? '代码渲染' : 'MiniMax H3');

/**
 * 作品库:成片卡片 + 详情。H3 成片每张卡片和详情页都醒目标注「MiniMax H3」(许可第 IV.2 条);
 * 代码渲染(HyperFrames)的标「代码渲染」,不写 AI 生成。
 */
export function VideoGallery({ videos }: { videos: VideoRecord[] }) {
  const [open, setOpen] = useState<VideoRecord | null>(null);
  if (videos.length === 0) return null;
  return (
    <section className="gallery" data-testid="video-gallery" aria-label="作品库">
      <h2>作品库</h2>
      <div className="cards">
        {videos.map((v) => (
          <button type="button" key={v.id} className="card" data-testid="video-card" onClick={() => setOpen(v)}>
            <span className="badge">{badge(v)}</span>
            <span className="card-title">{v.prompt.split(/\s+/).slice(0, 8).join(' ')}…</span>
            <span className="notice">
              {v.seconds} 秒 · {new Date(v.createdAt).toLocaleString()}
            </span>
          </button>
        ))}
      </div>
      {open && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label="成片详情" data-testid="video-detail">
            <h2>
              <span className="badge">{badge(open)}</span> 成片详情
            </h2>
            <video src={videoFileUrl(open.id)} controls className="player" data-testid="video-player" />
            {isCode(open) ? (
              <p className="notice" data-testid="code-render-note">
                用代码渲染(HyperFrames),没有使用 AI 模型
              </p>
            ) : (
              <p className="notice">AI-generated with MiniMax H3 · 由 MiniMax H3 生成</p>
            )}
            <dl className="meta">
              <dt>生成时间</dt>
              <dd>{new Date(open.createdAt).toLocaleString()}</dd>
              <dt>时长</dt>
              <dd>
                {open.seconds} 秒({open.frames} 帧,{open.seconds > 0 ? Math.round(open.frames / open.seconds) : '?'} fps)
              </dd>
              <dt>耗时</dt>
              <dd>{(open.elapsedMs / 1000).toFixed(1)} 秒</dd>
              {open.motion && (
                <>
                  <dt>分镜</dt>
                  <dd data-testid="storyboard">{open.motion.shots.map((s) => `${s.label} ${s.start}–${s.end} 秒`).join(' → ')}</dd>
                </>
              )}
              {!isCode(open) && (
                <>
                  <dt>显存峰值</dt>
                  <dd>
                    {mib(open.peakVramMiB)}
                    {open.metricsSimulated && '(模拟值)'}
                  </dd>
                  <dt>内存峰值(整机)</dt>
                  <dd>
                    {mib(open.peakRamMiB)}
                    {open.metricsSimulated && '(模拟值)'}
                  </dd>
                </>
              )}
              <dt>{isCode(open) ? '标题' : '提示词'}</dt>
              <dd className="prompt">{open.prompt}</dd>
            </dl>
            {open.metricsSimulated && (
              <p className="notice" data-testid="simulated-note">
                这条是假 ComfyUI 回放生成的占位视频,显存与内存数字是模拟值,不是真实测量。
              </p>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => setOpen(null)}>
                关闭
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
