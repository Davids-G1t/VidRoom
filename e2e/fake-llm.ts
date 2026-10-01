import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CAT_PROMPT } from '../apps/host/test/fixtures/h3-prompts';

/**
 * 假 DeepSeek 服务(OpenAI 兼容的 /chat/completions,非流式),给桌面版 e2e 用:
 * - 第一轮让 agent 调 probe_gpu;带着工具结果的第二轮把结果里的 summary 原样说出来;
 * - 用户消息里带「视频」或「橘猫」:第一轮调 generate_video(固定的 180–260 词英文提示词、5 秒),
 *   第二轮按工具结果说「已生成」或转述失败原因;
 * - 用户消息里带「开场动画」:第一轮调 render_motion(录好的固定分镜参数:标题 VidRoom、10 秒、gradient),
 *   第二轮按工具结果说「已渲染」或转述失败原因;
 * - 用户消息以「慢」字开头就先挂住,直到测试调 release(),用来模拟「有任务在跑」;
 * - 记下每个请求的 Authorization 头,用来核对 Host 拿到的正是设置页存进去的 key。
 */
export interface FakeLlm {
  baseURL: string;
  authHeaders: string[];
  /** 当前挂住未答的请求数 */
  held: () => number;
  release: () => void;
  close: () => Promise<void>;
}

interface ChatBody {
  messages: Array<{ role: string; content?: string | null }>;
}

/** 录好的「做一条10秒的开场动画,标题是VidRoom」的工具调用参数 */
export const MOTION_CALL = { title: 'VidRoom', seconds: 10, style: 'gradient' };

function motionReply(toolContent: string): string {
  try {
    const r = JSON.parse(toolContent);
    return r.ok ? `已用代码渲染了一条 ${r.video.seconds} 秒的开场动画,放进作品库了。` : `没能渲染:${r.reason}`;
  } catch {
    return toolContent;
  }
}

function videoReply(toolContent: string): string {
  try {
    const r = JSON.parse(toolContent);
    return r.ok ? `已用 MiniMax H3 生成 ${r.video.seconds} 秒的视频,放进作品库了。` : `没能生成:${r.reason}`;
  } catch {
    return toolContent;
  }
}

const completion = (message: Record<string, unknown>, finishReason: string) => ({
  id: 'fake-1',
  object: 'chat.completion',
  created: 0,
  model: 'deepseek-v4-flash',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

function summaryOf(toolContent: string): string {
  try {
    const parsed = JSON.parse(toolContent);
    return typeof parsed.summary === 'string' ? parsed.summary : toolContent;
  } catch {
    return toolContent;
  }
}

export async function startFakeLlm(): Promise<FakeLlm> {
  const authHeaders: string[] = [];
  let waiting: Array<() => void> = [];

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    authHeaders.push(String(req.headers.authorization ?? ''));
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatBody;
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
    const tool = body.messages.find((m) => m.role === 'tool');

    let reply;
    if (lastUser?.content?.startsWith('慢')) {
      await new Promise<void>((resolve) => waiting.push(resolve));
      reply = completion({ content: '慢任务做完了。' }, 'stop');
    } else if (/开场动画/.test(lastUser?.content ?? '')) {
      reply = tool
        ? completion({ content: motionReply(String(tool.content ?? '')) }, 'stop')
        : completion(
            {
              content: null,
              tool_calls: [{ id: 'call_m1', type: 'function', function: { name: 'render_motion', arguments: JSON.stringify(MOTION_CALL) } }],
            },
            'tool_calls',
          );
    } else if (/视频|橘猫/.test(lastUser?.content ?? '')) {
      reply = tool
        ? completion({ content: videoReply(String(tool.content ?? '')) }, 'stop')
        : completion(
            {
              content: null,
              tool_calls: [
                {
                  id: 'call_v1',
                  type: 'function',
                  function: { name: 'generate_video', arguments: JSON.stringify({ prompt: CAT_PROMPT, seconds: 5 }) },
                },
              ],
            },
            'tool_calls',
          );
    } else if (!tool) {
      reply = completion(
        { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'probe_gpu', arguments: '{}' } }] },
        'tool_calls',
      );
    } else {
      reply = completion({ content: `探测结果:${summaryOf(String(tool.content ?? ''))}` }, 'stop');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });

  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    authHeaders,
    held: () => waiting.length,
    release: () => {
      const w = waiting;
      waiting = [];
      w.forEach((resolve) => resolve());
    },
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
