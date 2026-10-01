import { useEffect, useState, type FormEvent } from 'react';
import { About } from './About';
import {
  ABUSE_REPORT_URL,
  fetchJob,
  fetchStatus,
  fetchVideos,
  sendChat,
  type ChatMessage,
  type JobState,
  type StatusResult,
  type ToolCallRecord,
  type VideoRecord,
} from './api';
import { ComfyPanel } from './ComfyPanel';
import { desktopApi } from './desktop';
import { H3Panel } from './H3Panel';
import { Settings } from './Settings';
import { VideoGallery } from './VideoGallery';
import { WorkflowPanel } from './WorkflowPanel';

interface Entry extends ChatMessage {
  toolCalls?: ToolCallRecord[];
}

const NO_KEY_TEXT = '没有配置 API key,请去设置。';

function describeJob(j: JobState | null): string {
  if (j?.state === 'preparing') return `正在准备出片:${j.message}…`;
  if (j?.state === 'running') return j.max > 0 ? `MiniMax H3 正在生成视频:第 ${j.value} / ${j.max} 步` : 'MiniMax H3 正在生成视频…';
  return '思考中…';
}

/** 举报滥用:桌面版交给主进程用系统浏览器打开(页面不能开新窗口),浏览器里直接开新标签页 */
export function openAbuseReport(): void {
  const api = desktopApi();
  if (api) void api.openAbuseReport();
  else window.open(ABUSE_REPORT_URL, '_blank', 'noopener');
}

export function App() {
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [job, setJob] = useState<JobState | null>(null);
  const [videos, setVideos] = useState<VideoRecord[]>([]);

  useEffect(() => {
    fetchStatus().then(setStatus);
    fetchVideos().then(setVideos);
  }, []);

  // 聊天请求挂着的时候(可能正在出片),每秒取一次出片进度(Host 转发自 ComfyUI 的 WebSocket)
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => fetchJob().then(setJob), 1000);
    return () => {
      clearInterval(t);
      setJob(null);
    };
  }, [pending]);

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
    fetchVideos().then(setVideos);
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
        <nav className="menu" aria-label="菜单">
          <button type="button" onClick={() => setSettingsOpen((open) => !open)}>
            设置
          </button>
          <button type="button" onClick={() => setAboutOpen(true)}>
            关于
          </button>
          <button type="button" onClick={openAbuseReport}>
            举报滥用
          </button>
        </nav>
      </header>
      {aboutOpen && <About onClose={() => setAboutOpen(false)} onReport={openAbuseReport} />}

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

      <WorkflowPanel onNotice={setNotice} onVideosChanged={() => fetchVideos().then(setVideos)} />

      <H3Panel />

      <ComfyPanel />

      <VideoGallery videos={videos} />

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
        {pending && (
          <div className="message assistant pending" data-testid="pending">
            {describeJob(job)}
          </div>
        )}
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
