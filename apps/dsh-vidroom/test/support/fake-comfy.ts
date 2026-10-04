/**
 * 假 ComfyUI:真开一个 HTTP 服务,按真机形状答 /system_stats、/prompt、/history/<id>、/view。
 * 集成测试里用来替掉那块 GPU —— 插件这一侧(客户端、runtime、路由、工具)全是真的。
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { ApiPrompt } from '../../src/h3.js';

export interface FakeComfy {
  baseUrl: string;
  /** 每次 POST /prompt 提交的图(按顺序)。 */
  submissions: ApiPrompt[];
  /** 每次 POST /prompt 的完整请求体。 */
  bodies: Array<{ prompt: ApiPrompt; client_id?: string; extra_data?: Record<string, unknown> }>;
  close(): Promise<void>;
}

export interface FakeComfyOptions {
  /** 显卡总显存(GiB),默认 24(默认档放行)。 */
  vramTotalGiB?: number;
  /** 前几次查历史先答"还没进历史"(模拟排队与在跑)。 */
  historyMisses?: number;
  /** 让任务在 ComfyUI 那边失败。 */
  fail?: boolean;
  filename?: string;
}

async function readBody(request: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeComfy(options: FakeComfyOptions = {}): Promise<FakeComfy> {
  const totalGiB = options.vramTotalGiB ?? 24;
  const filename = options.filename ?? 'h3_00001.mp4';
  const misses = options.historyMisses ?? 1;
  const submissions: ApiPrompt[] = [];
  const bodies: FakeComfy['bodies'] = [];
  let polls = 0;

  const server = createServer((request, response) => {
    const send = (status: number, payload: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/system_stats') {
        send(200, { devices: [{ vram_total: totalGiB * 1024 ** 3, vram_free: (totalGiB - 6) * 1024 ** 3 }] });
        return;
      }
      if (url.pathname === '/prompt' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request)) as FakeComfy['bodies'][number];
        bodies.push(body);
        submissions.push(body.prompt);
        send(200, { prompt_id: `fake-${submissions.length}` });
        return;
      }
      if (url.pathname.startsWith('/history/')) {
        const id = decodeURIComponent(url.pathname.slice('/history/'.length));
        polls += 1;
        if (polls <= misses) {
          send(200, {});
          return;
        }
        send(200, {
          [id]: options.fail
            ? {
                outputs: {},
                status: {
                  status_str: 'error',
                  completed: false,
                  messages: [
                    [
                      'execution_error',
                      { exception_message: 'CUDA out of memory', node_type: 'SamplerCustom', node_id: '140:129' },
                    ],
                  ],
                },
              }
            : {
                outputs: { '140:133': { videos: [{ filename, subfolder: '', type: 'output' }] } },
                status: { status_str: 'success', completed: true, messages: [] },
              },
        });
        return;
      }
      if (url.pathname === '/view') {
        response.writeHead(200, { 'content-type': 'video/mp4' });
        response.end('fake-mp4-bytes');
        return;
      }
      send(404, { error: `假 ComfyUI 没有这个端点:${url.pathname}` });
    })();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('假 ComfyUI 没拿到端口');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    submissions,
    bodies,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
