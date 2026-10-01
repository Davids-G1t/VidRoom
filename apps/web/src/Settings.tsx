import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { fetchCloud, fetchStatus, saveSettings, type CloudKind, type CloudStatus } from './api';
import { desktopApi, type LlmProvider } from './desktop';

const PROVIDERS: Array<{ id: LlmProvider; label: string; note: string }> = [
  { id: 'deepseek', label: 'DeepSeek', note: '默认' },
  { id: 'anthropic', label: 'Anthropic', note: 'Claude,可选' },
];
const labelOf = (p: LlmProvider) => PROVIDERS.find((x) => x.id === p)!.label;

/**
 * 设置页:选用哪家 LLM(DeepSeek 或 Anthropic),给它填 key;再配云端两家(生视频/生图,BYOK)的 key;
 * 加一个「不用本机显卡」开关。key 交给桌面版主进程加密保存,页面之后再也拿不回来,只能知道「有没有配置」。
 * 浏览器里打开(命令行开发)时没有存 key 的能力,但开关仍可用(存 Host 的数据目录)。
 */
export function Settings({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const api = desktopApi();
  const [provider, setProvider] = useState<LlmProvider>('deepseek');
  const [providers, setProviders] = useState<Record<LlmProvider, boolean> | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [cloudConfigured, setCloudConfigured] = useState<{ video: boolean; image: boolean }>({ video: false, image: false });
  const [cloudKind, setCloudKind] = useState<CloudKind>('video');
  const [cloudKey, setCloudKey] = useState('');
  const [cloudSaving, setCloudSaving] = useState(false);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const [forceNoLocalGpu, setForceNoLocalGpu] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    const s = await api?.getKeyStatus();
    if (!s) return;
    setProvider(s.provider);
    setProviders(s.providers);
  }, [api]);

  useEffect(() => {
    void refresh();
    void fetchCloud().then(setCloud);
    void api?.getCloudKeyStatus().then(setCloudConfigured);
    void fetchStatus().then((s) => setForceNoLocalGpu(s.kind === 'ok' ? s.forcedNoLocalGpu === true : null));
  }, [refresh, api]);

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
  const cloudInfo = cloud?.providers.find((p) => p.kind === cloudKind) ?? null;

  async function submitCloudKey(e: FormEvent) {
    e.preventDefault();
    if (!api || !cloudKey.trim() || cloudSaving) return;
    setCloudSaving(true);
    setCloudMessage(null);
    try {
      const result = await api.setCloudKey(cloudKey, cloudKind);
      if (result.ok) {
        setCloudKey('');
        setCloudMessage('已保存。');
        setCloudConfigured(await api.getCloudKeyStatus());
      } else {
        setCloudMessage(result.message);
      }
    } catch {
      setCloudMessage('保存失败,请重试。');
    } finally {
      setCloudSaving(false);
    }
  }

  async function toggleForceNoLocalGpu(next: boolean) {
    // 先按用户的动作切,别等网络往返 —— 往返期间控件会被 React 拉回原状,看起来像点了没反应
    setForceNoLocalGpu(next);
    const saved = await saveSettings({ forceNoLocalGpu: next });
    if (!saved) {
      setForceNoLocalGpu(!next);
      setMessage('设置没保存上,请重试。');
      return;
    }
    setForceNoLocalGpu(saved.forceNoLocalGpu);
    onSaved();
  }

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

      <fieldset className="cloud-settings">
        <legend>云端出片(可选,自带 key)</legend>
        <p>
          本机跑不动(没 N 卡或显存太小)时,可以用云端生成。云端按量计费:
          {cloud
            ? ` 生视频 720p ${(cloud.prices.videoCentsPerSecond['720p'] / 100).toFixed(2)} 元/秒、1080p ${(
                cloud.prices.videoCentsPerSecond['1080p'] / 100
              ).toFixed(2)} 元/秒;生图 ${(cloud.prices.imageCentsPerImage / 100).toFixed(2)} 元/张。`
            : ' 单价见云端控制台。'}
          key 由你自己申请,存在本机(和 LLM key 一样的加密存储)。
        </p>
        <label>
          <input
            type="radio"
            name="cloud-kind"
            checked={cloudKind === 'video'}
            onChange={() => {
              setCloudKind('video');
              setCloudMessage(null);
            }}
          />
          生视频
        </label>
        <label>
          <input
            type="radio"
            name="cloud-kind"
            checked={cloudKind === 'image'}
            onChange={() => {
              setCloudKind('image');
              setCloudMessage(null);
            }}
          />
          生图
        </label>
        <p data-testid="cloud-key-status">
          {cloudInfo ? `${cloudInfo.label}(${cloudInfo.model})` : '云端服务'}:{cloudConfigured[cloudKind] ? '已配置' : '未配置'}
          {cloudInfo && (
            <>
              {' '}
              <a href={cloudInfo.consoleUrl} target="_blank" rel="noreferrer">
                去申请 key
              </a>
              {`(${cloudInfo.keyHint})`}
            </>
          )}
        </p>
        {api ? (
          <form onSubmit={submitCloudKey}>
            <label>
              {cloudConfigured[cloudKind] ? '换一个新的 key' : '填入 key'}
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="云端 key"
                data-testid="cloud-key-input"
                value={cloudKey}
                onChange={(e) => setCloudKey(e.target.value)}
              />
            </label>
            <button type="submit" data-testid="save-cloud-key" disabled={!cloudKey.trim() || cloudSaving}>
              保存云端 key
            </button>
          </form>
        ) : (
          <p>
            命令行开发时用环境变量 VIDROOM_CLOUD_VIDEO_KEY_FILE / VIDROOM_CLOUD_IMAGE_KEY_FILE 指定 key 文件。
          </p>
        )}

        <label>
          <input
            type="checkbox"
            data-testid="force-no-gpu"
            checked={forceNoLocalGpu === true}
            disabled={forceNoLocalGpu === null}
            onChange={(e) => void toggleForceNoLocalGpu(e.target.checked)}
          />
          不用本机显卡出片(一律当成本机跑不动,走云端或代码渲染)
        </label>
      </fieldset>
      {cloudMessage && (
        <p className="notice" data-testid="cloud-key-message">
          {cloudMessage}
        </p>
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
