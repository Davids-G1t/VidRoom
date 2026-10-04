/**
 * dsh-vidroom 的样式,注入一次。颜色全部走宿主主题变量(--dsw-alias-*),
 * 所以亮色/暗色跟着宿主走。
 */
export const CSS = `
.dvr-panel {
  position: fixed; right: 16px; bottom: 16px; width: 400px; max-width: calc(100vw - 32px);
  max-height: 76vh; display: flex; flex-direction: column; z-index: 40;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  box-shadow: 0 8px 28px rgb(0 0 0 / 22%); font-size: 13px; line-height: 1.5;
}
.dvr-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-weight: 600;
}
.dvr-head-actions { display: flex; align-items: center; gap: 6px; }
.dvr-body { overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.dvr-env { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dvr-detail { display: flex; flex-direction: column; gap: 8px; }
.dvr-env--bad { color: var(--dsw-alias-state-error-primary); }
.dvr-list { display: flex; flex-direction: column; gap: 6px; }
.dvr-item {
  text-align: left; width: 100%; cursor: pointer; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: inherit; font: inherit;
}
.dvr-item:hover { border-color: var(--dsw-alias-label-secondary); }
.dvr-item--active { border-color: var(--dsw-alias-state-success-primary); }
.dvr-item-title { font-weight: 600; }
.dvr-item-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dvr-tag {
  border-radius: 999px; padding: 1px 8px; font-size: 11px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
}
.dvr-skill {
  white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, monospace; font-size: 12px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px; max-height: 240px; overflow: auto;
}
.dvr-form { display: flex; flex-direction: column; gap: 8px; }
.dvr-field { display: flex; align-items: center; gap: 8px; }
.dvr-field label { flex: 0 0 84px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dvr-input, .dvr-textarea {
  flex: 1 1 auto; min-width: 0; padding: 5px 8px; border-radius: 6px; font: inherit;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: inherit;
}
.dvr-textarea { min-height: 56px; resize: vertical; font-family: ui-monospace, monospace; }
.dvr-btn {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent;
  color: inherit; padding: 5px 12px; font-size: 13px; cursor: pointer;
}
.dvr-btn:disabled { opacity: 0.5; cursor: default; }
.dvr-check { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.dvr-status { font-size: 12px; }
.dvr-status--ok { color: var(--dsw-alias-state-success-primary); }
.dvr-status--err { color: var(--dsw-alias-state-error-primary); }
.dvr-media video, .dvr-media img, .dvr-media audio { display: block; width: 100%; border-radius: 8px; background: #000; }
.dvr-media-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; margin-top: 4px; }
.dvr-card {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px 12px;
  margin: 4px 0; font-size: 13px; display: flex; flex-direction: column; gap: 6px;
}
.dvr-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dvr-error { color: var(--dsw-alias-state-error-primary); }
`;

const STYLE_ID = 'dsh-vidroom-styles';

/** 注入样式,返回摘除函数。 */
export function injectStyles(): () => void {
  const existing = document.getElementById(STYLE_ID);
  if (existing !== null) return () => {};
  const element = document.createElement('style');
  element.id = STYLE_ID;
  element.textContent = CSS;
  document.head.appendChild(element);
  return () => {
    element.remove();
  };
}
