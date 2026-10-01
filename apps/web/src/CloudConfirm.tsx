import { useState } from 'react';
import { generateCloud, type CloudRequest } from './api';

export interface CloudEstimate {
  /** 工具名(区分生视频/生图,给标题用) */
  toolName: string;
  estimateText: string;
  request: CloudRequest;
}

/**
 * 从工具调用记录里挑出云端估价。云端工具**只估价不生成**,产物形如
 * `{ status: 'needs_confirmation', estimateText, estimateCents, request }`;
 * 只有这里(用户点「确认生成」)才会真的花钱,见 apps/host/src/server.ts 的 /api/cloud/generate。
 */
export function cloudEstimates(toolCalls: Array<{ toolName: string; output: unknown }> | undefined): CloudEstimate[] {
  if (!toolCalls) return [];
  const out: CloudEstimate[] = [];
  for (const call of toolCalls) {
    if (call.toolName !== 'cloud_generate_video' && call.toolName !== 'cloud_generate_image') continue;
    const o = call.output as { status?: unknown; estimateText?: unknown; request?: unknown } | null;
    if (o?.status !== 'needs_confirmation' || typeof o.estimateText !== 'string') continue;
    const request = o.request as CloudRequest | undefined;
    if (!request || (request.kind !== 'video' && request.kind !== 'image')) continue;
    out.push({ toolName: call.toolName, estimateText: o.estimateText, request });
  }
  return out;
}

const TITLES: Record<string, string> = { cloud_generate_video: '云端生视频', cloud_generate_image: '云端生图' };

function describe(request: CloudRequest): string {
  return request.kind === 'video'
    ? `提示词:${request.prompt}(${request.seconds} 秒,${request.resolution})`
    : `提示词:${request.prompt}(${request.count} 张)`;
}

/**
 * 估价卡:模型只能碰「估价」这一步,真正的生成要用户在这里点确认 ——
 * 钱花不花由人决定,模型自己花不了钱。
 */
export function CloudConfirm({
  estimates,
  onNotice,
  onVideosChanged,
}: {
  estimates: CloudEstimate[];
  onNotice: (message: string | null) => void;
  onVideosChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState<Record<number, string>>({});
  const [images, setImages] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  if (estimates.length === 0) return null;

  async function confirm(index: number) {
    const estimate = estimates[index];
    setBusy(index);
    onNotice(null);
    const result = await generateCloud(estimate.request);
    setBusy(null);
    if (result.ok && result.kind === 'video') {
      setDone((d) => ({ ...d, [index]: `已生成:${result.video.prompt}` }));
      onVideosChanged();
    } else if (result.ok && result.kind === 'image') {
      setDone((d) => ({ ...d, [index]: '已生成:' }));
      setImages((m) => ({ ...m, [index]: `/api/cloud/images/${encodeURIComponent(result.image.id)}.png` }));
    } else {
      setErrors((e) => ({ ...e, [index]: (result as { reason: string }).reason }));
    }
  }

  return (
    <div className="cloud-estimates" data-testid="cloud-confirm">
      {estimates.map((estimate, index) => (
        <section className="cloud-estimate" key={index}>
          <h4>{TITLES[estimate.toolName] ?? '云端生成'}</h4>
          <p>{describe(estimate.request)}</p>
          <p data-testid="cloud-estimate-text">{estimate.estimateText}</p>
          {done[index] !== undefined ? (
            <>
              <p className="notice" data-testid="cloud-done">
                {done[index]}
              </p>
              {images[index] && <img className="cloud-image" src={images[index]} alt={estimate.request.prompt} />}
            </>
          ) : (
            <button type="button" data-testid="cloud-confirm-button" disabled={busy !== null} onClick={() => void confirm(index)}>
              {busy === index ? '正在生成…' : '确认生成(会计费)'}
            </button>
          )}
          {errors[index] && (
            <p className="notice" data-testid="cloud-error">
              {errors[index]}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
