import { useEffect, useState } from 'react';
import { fetchText, type H3Status } from './api';

/**
 * 下载 MiniMax H3 权重前的同意页:中文摘要 + 许可全文(随页面分发的原文)。
 * 不勾选就不能点「同意并下载」;点「关闭」什么请求都不发。
 */
export function LicenseDialog({
  license,
  onAccept,
  onClose,
}: {
  license: H3Status['license'];
  onAccept: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    fetchText(license.path).then(setText);
  }, [license.path]);

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-label="MiniMax H3 许可" data-testid="license-dialog">
        <h2>下载 MiniMax H3 之前,请阅读许可</h2>
        <p>
          VidRoom 用 <strong>MiniMax H3</strong> 在你的电脑上生成视频。模型权重约 40 GB,从 Hugging Face 下载,
          受 <strong>{license.name}</strong> 约束。要点(中文摘要,以下方英文原文为准):
        </p>
        <ul data-testid="license-summary">
          <li>
            <strong>地区限制</strong>:许可只在欧盟、英国、韩国、美国<strong>以外</strong>的地区有效。身处这些地区请不要下载和使用。
          </li>
          <li>
            <strong>禁止用途</strong>(附件 A 共 20 条):违法或侵犯他人权利;伤害自己或他人,或把生成的内容拿去伤害人;任何剥削或伤害未成年人的内容;
            为伤害他人或影响选举制作虚假信息;刷量与假评论;诽谤、骚扰;恶意软件;为伤害他人泄露个人信息;
            公开发布却不标注是 AI 生成;未经同意冒充他人;在执法、医疗、信贷、就业等关键领域做高风险自动化决策;
            违背其他国家或地区的社会伦理标准;暴力极端主义与恐怖主义;基于受保护特征的歧视;利用弱势人群的弱点造成伤害;
            军事用途;无资质从事金融、法律、医疗等专业活动;绕过安全防护;在适用地区以外使用。
          </li>
          <li>
            <strong>不许拿生成的内容训练或改进别的 AI 模型</strong>(第 V.3 条)。
          </li>
          <li>生成的内容由你自己负责;公开发布时请注明是 AI 生成。</li>
        </ul>
        <details open>
          <summary>许可全文(英文原文)</summary>
          <pre className="license-text" data-testid="license-text">
            {text ?? '正在加载许可全文…'}
          </pre>
        </details>
        <label className="consent">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          我已阅读并同意 {license.name},并确认我不在欧盟、英国、韩国、美国境内使用
        </label>
        <div className="modal-actions">
          <button type="button" disabled={!checked || text === null} onClick={onAccept}>
            同意并下载
          </button>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </section>
    </div>
  );
}
