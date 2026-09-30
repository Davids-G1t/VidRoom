import { mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeepSeekModel, runChat } from '../src/agent.js';
import { VideoEditor } from '../src/ffmpeg/editor.js';
import { ensureFfmpeg, type FfmpegPaths } from '../src/ffmpeg/install.js';
import { VideoLibrary, type VideoRecord } from '../src/h3/library.js';
import { brightPixelsInBottom, ffprobeJson, makeClip, snapshot, testTmpDir } from './fixtures/media.js';

/**
 * 验收①的链路:作品库里有一条 5 秒的占位视频(测试现做,不是模型输出),对 agent 说
 * 「把刚才那条视频剪成前2秒,底部加一行字幕『你好』」→ list_videos → trim_video → add_subtitle →
 * 成片 ffprobe 量是 2 秒、抽帧底部有字。LLM 是本机假服务(按固定剧本发工具调用),剪辑是真 ffmpeg。
 * 设了 VIDROOM_EDIT_SNAPSHOT_DIR 就把抽的那一帧存成 PNG 放那里(截图不进仓库)。
 */

interface Msg {
  role: string;
  content?: string | null;
}

const completion = (message: Record<string, unknown>, finish: string) => ({
  id: 'fake',
  object: 'chat.completion',
  created: 0,
  model: 'deepseek-v4-flash',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

const call = (name: string, args: unknown) =>
  completion({ content: null, tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');

function parseTool(content: string | null | undefined): any {
  const v = JSON.parse(String(content ?? 'null'));
  return typeof v === 'string' ? JSON.parse(v) : v;
}

/** 剧本:没工具结果 → list_videos;拿到列表 → 剪最新一条前 2 秒;拿到剪切结果 → 加字幕;拿到字幕结果 → 收尾 */
async function startScriptedLlm(): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Msg[] };
    const tools = messages.filter((m) => m.role === 'tool');
    let reply;
    if (tools.length === 0) reply = call('list_videos', {});
    else if (tools.length === 1) reply = call('trim_video', { video_id: parseTool(tools[0].content)[0].id, start: 0, end: 2 });
    else if (tools.length === 2) reply = call('add_subtitle', { video_id: parseTool(tools[1].content).video.id, text: '你好', position: 'bottom' });
    else {
      const r = parseTool(tools[2].content);
      reply = completion({ content: r.ok ? `好了,新视频 ${r.video.seconds} 秒,底部加了字幕。` : `失败:${r.reason}` }, 'stop');
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

let ff: FfmpegPaths;
let dir: string;
let llm: Awaited<ReturnType<typeof startScriptedLlm>>;

beforeAll(async () => {
  ff = await ensureFfmpeg();
  dir = testTmpDir('agent-edit-');
  llm = await startScriptedLlm();
}, 600_000);

afterAll(async () => {
  await llm?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('agent 剪辑工具(验收①链路)', () => {
  it('「剪成前2秒,底部加一行字幕『你好』」→ 2 秒成片,抽帧底部有字', async () => {
    const library = new VideoLibrary(join(dir, 'library'));
    mkdirSync(library.dir, { recursive: true });
    const src: VideoRecord = {
      id: '20261001T000000-placeholder',
      model: 'MiniMax H3',
      prompt: 'A placeholder clip made by ffmpeg testsrc for the editing test.',
      frames: 120,
      seconds: 5,
      seed: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      elapsedMs: 0,
      peakVramMiB: null,
      peakRamMiB: null,
      metricsSimulated: true,
      file: library.fileFor('20261001T000000-placeholder'),
    };
    makeClip(ff, src.file, { seconds: 5, gop: 24, comment: 'AI-generated with MiniMax H3' });
    await library.add(src);
    const editor = new VideoEditor({ library, ffmpeg: async () => ff, workDir: join(dir, 'work') });

    const reply = await runChat(
      createDeepSeekModel('test-key', llm.baseURL),
      [{ role: 'user', content: '把刚才那条视频剪成前2秒,底部加一行字幕『你好』' }],
      { editor },
    );
    console.log(`[agent] 工具调用 ${JSON.stringify(reply.toolCalls.map((c) => [c.toolName, c.input]))}\n[agent] 回答 ${reply.text}`);
    expect(reply.toolCalls.map((c) => c.toolName)).toEqual(['list_videos', 'trim_video', 'add_subtitle']);

    const trimmed = reply.toolCalls[1].output as any;
    const subbed = reply.toolCalls[2].output as any;
    expect(trimmed.ok).toBe(true);
    expect(subbed.ok).toBe(true);
    expect(subbed.video.editedFrom).toEqual({ op: 'subtitle', sources: [trimmed.video.id], detail: '你好' });

    const lib = await library.list();
    expect(lib.map((v) => v.id)).toEqual([subbed.video.id, trimmed.video.id, src.id]);
    const out = lib[0].file;
    const probe = ffprobeJson(ff, out);
    console.log(`[agent] 成片 ffprobe:duration=${probe.format.duration},tags=${JSON.stringify(probe.format.tags)}`);
    expect(Number(probe.format.duration)).toBeCloseTo(2, 1);
    expect(probe.format.tags?.comment).toBe('AI-generated with MiniMax H3');
    const bright = brightPixelsInBottom(ff, out, 1);
    console.log(`[agent] 第 1 秒那帧底部四分之一里亮像素 ${bright} 个(原片为 ${brightPixelsInBottom(ff, src.file, 1)})`);
    expect(bright).toBeGreaterThan(50);

    const shotDir = process.env.VIDROOM_EDIT_SNAPSHOT_DIR;
    if (shotDir) {
      mkdirSync(shotDir, { recursive: true });
      const png = join(shotDir, 'batch4-subtitle-frame.png');
      snapshot(ff, out, 1, png);
      console.log(`[agent] 抽帧截图 ${png}`);
    }
  }, 120_000);
});
