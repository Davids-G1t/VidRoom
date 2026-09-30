import { useEffect, useState, type FormEvent } from 'react';
import { desktopApi } from './desktop';

/**
 * 设置页:填 DeepSeek key。key 交给桌面版主进程加密保存,页面之后再也拿不回来,
 * 只能知道「有没有配置」。浏览器里打开(命令行开发)时没有这个能力。
 */
export function Settings({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const api = desktopApi();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api?.getKeyStatus().then((s) => setConfigured(s.configured));
  }, [api]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!api || !key.trim() || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await api.setKey(key);
      if (result.ok) {
        setKey('');
        setConfigured(true);
        setMessage('已保存。');
        onSaved();
      } else {
        setMessage(result.message);
      }
    } catch {
      setMessage('保存失败,请重试。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings" data-testid="settings" aria-label="设置">
      <h2>设置</h2>
      {!api ? (
        <p>设置页只在桌面版里可用。命令行开发时用环境变量 VIDROOM_DEEPSEEK_KEY_FILE 指定 key 文件。</p>
      ) : (
        <form onSubmit={onSubmit}>
          <p data-testid="key-status">
            DeepSeek API key:{configured === null ? '…' : configured ? '已配置' : '未配置'}
          </p>
          <label>
            {configured ? '换一个新的 key' : '填入 key'}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="DeepSeek API key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <button type="submit" disabled={!key.trim() || saving}>
            保存
          </button>
        </form>
      )}
      {message && (
        <p className="notice" data-testid="settings-message">
          {message}
        </p>
      )}
      <button type="button" onClick={onClose}>
        返回
      </button>
    </section>
  );
}
