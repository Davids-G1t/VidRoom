import { useEffect, useState, type FormEvent } from 'react';
import { fetchStatus, sendChat, type ChatMessage, type StatusResult, type ToolCallRecord } from './api';
import { ComfyPanel } from './ComfyPanel';
import { Settings } from './Settings';

interface Entry extends ChatMessage {
  toolCalls?: ToolCallRecord[];
}

const PRESET_WORKFLOWS = ['文字生成视频', '图片生成视频'];
const NO_KEY_TEXT = '没有配置 API key,请去设置。';

export function App() {
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    fetchStatus().then(setStatus);
  }, []);

  const hasKey = status?.kind === 'ok' && status.hasApiKey;
  const noKey = status?.kind === 'ok' && !status.hasApiKey;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || pending) return;
    const history: Entry[] = [...entries, { role: 'user', content: text }];
    setEntries(history);
    setInput('');
    setPending(true);
    setNotice(null);
    const result = await sendChat(history.map(({ role, content }) => ({ role, content })));
    setPending(false);
    if (result.kind === 'ok') {
      setEntries([...history, { role: 'assistant', content: result.text, toolCalls: result.toolCalls }]);
    } else if (result.kind === 'no_api_key') {
      setStatus({ kind: 'ok', hasApiKey: false });
    } else if (result.kind === 'unauthorized') {
      setStatus({ kind: 'unauthorized' });
    } else {
      setNotice(result.message);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>VidRoom</h1>
        <button type="button" onClick={() => setSettingsOpen((open) => !open)}>
          设置
        </button>
      </header>

      {status?.kind === 'unauthorized' && (
        <div className="banner" role="alert" data-testid="unauthorized-notice">
          未登录:请用 VidRoom 启动时打印的启动地址打开本页。
        </div>
      )}
      {status?.kind === 'error' && (
        <div className="banner" role="alert">
          连不上 VidRoom Host。
        </div>
      )}
      {noKey && (
        <div className="banner" role="alert" data-testid="no-key-notice">
          {NO_KEY_TEXT}{' '}
          <a
            href="#settings"
            onClick={(e) => {
              e.preventDefault();
              setSettingsOpen(true);
            }}
          >
            去设置
          </a>
        </div>
      )}

      {settingsOpen && (
        <Settings onSaved={() => fetchStatus().then(setStatus)} onClose={() => setSettingsOpen(false)} />
      )}

      <section className="presets" data-testid="preset-workflows" aria-label="预设工作流">
        <h2>预设工作流</h2>
        <div className="preset-buttons">
          {PRESET_WORKFLOWS.map((name) => (
            <button key={name} type="button" onClick={() => setNotice(`「${name}」即将推出。`)}>
              {name}
            </button>
          ))}
        </div>
      </section>

      <ComfyPanel />

      {notice && (
        <p className="notice" data-testid="notice">
          {notice}
        </p>
      )}

      <main className="messages" data-testid="messages">
        {entries.map((m, i) => (
          <div key={i} className={`message ${m.role}`} data-testid={`message-${m.role}`}>
            <div className="content" data-testid="message-content">
              {m.content}
            </div>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <details className="tool-calls">
                <summary>调用了工具:{m.toolCalls.map((t) => t.toolName).join('、')}</summary>
                <pre>{JSON.stringify(m.toolCalls, null, 2)}</pre>
              </details>
            )}
          </div>
        ))}
        {pending && <div className="message assistant pending">思考中…</div>}
      </main>

      <form className="composer" onSubmit={onSubmit}>
        <textarea
          aria-label="输入消息"
          placeholder={hasKey ? '跟 VidRoom 说点什么,比如「我这台电脑能跑什么」' : '配置 API key 后才能聊天'}
          value={input}
          disabled={!hasKey}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" disabled={!hasKey || pending || !input.trim()}>
          发送
        </button>
      </form>
    </div>
  );
}
