import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { desktopApi, type LlmProvider } from './desktop';

const PROVIDERS: Array<{ id: LlmProvider; label: string; note: string }> = [
  { id: 'deepseek', label: 'DeepSeek', note: '默认' },
  { id: 'anthropic', label: 'Anthropic', note: 'Claude,可选' },
];
const labelOf = (p: LlmProvider) => PROVIDERS.find((x) => x.id === p)!.label;

/**
 * 设置页:选用哪家 LLM(DeepSeek 或 Anthropic),给它填 key。key 交给桌面版主进程加密保存,
 * 页面之后再也拿不回来,只能知道「有没有配置」。浏览器里打开(命令行开发)时没有这个能力。
 */
export function Settings({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const api = desktopApi();
  const [provider, setProvider] = useState<LlmProvider>('deepseek');
  const [providers, setProviders] = useState<Record<LlmProvider, boolean> | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await api?.getKeyStatus();
    if (!s) return;
    setProvider(s.provider);
    setProviders(s.providers);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function choose(next: LlmProvider) {
    if (!api || next === provider || saving) return;
    setMessage(null);
    setProvider(next);
    const result = await api.setProvider(next);
    if (!result.ok) setMessage(result.message);
    await refresh();
    onSaved();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!api || !key.trim() || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await api.setKey(key, provider);
      if (result.ok) {
        setKey('');
        setMessage('已保存。');
        await refresh();
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

  const configured = providers ? providers[provider] : null;
  return (
    <section className="settings" data-testid="settings" aria-label="设置">
      <h2>设置</h2>
      {!api ? (
        <p>
          设置页只在桌面版里可用。命令行开发时用环境变量 VIDROOM_DEEPSEEK_KEY_FILE(或 VIDROOM_LLM_PROVIDER=anthropic 加
          VIDROOM_ANTHROPIC_KEY_FILE)指定 key 文件。
        </p>
      ) : (
        <form onSubmit={onSubmit}>
          <fieldset>
            <legend>用哪家 LLM</legend>
            {PROVIDERS.map((p) => (
              <label key={p.id}>
                <input type="radio" name="llm-provider" value={p.id} checked={provider === p.id} onChange={() => void choose(p.id)} />
                {p.label}({p.note})
              </label>
            ))}
          </fieldset>
          <p data-testid="key-status">
            {labelOf(provider)} API key:{configured === null ? '…' : configured ? '已配置' : '未配置'}
          </p>
          <label>
            {configured ? '换一个新的 key' : '填入 key'}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${labelOf(provider)} API key`}
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
