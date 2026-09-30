import { fileURLToPath } from 'node:url';
import { createDeepSeekModel } from './agent.js';
import { KEY_FILE_ENV, loadDeepSeekKey } from './key.js';
import { parseParentMessage, type HostToParent } from './parent-ipc.js';
import { startHost } from './server.js';

const webDir = process.env.VIDROOM_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const port = Number(process.env.VIDROOM_PORT ?? 0);
const baseURL = process.env.VIDROOM_DEEPSEEK_BASE_URL || undefined;

const modelFor = (apiKey: string | null) => (apiKey ? createDeepSeekModel(apiKey, baseURL) : null);

/**
 * 两种起法:
 * - 桌面壳用 child_process.fork() 起(有 IPC 通道):key 只从 IPC 通道收,不读文件、不读环境变量;
 *   启动地址也只从 IPC 回给壳,不打印。父进程断开(壳退出或崩溃)就跟着退出,不留孤儿。
 * - 命令行起(开发用):key 从 VIDROOM_DEEPSEEK_KEY_FILE 指向的文件读,启动地址打印到控制台。
 */
if (process.send) {
  const send = (msg: HostToParent) => process.send!(msg);
  let host: Awaited<ReturnType<typeof startHost>> | null = null;

  const handle = async (raw: unknown) => {
    const msg = parseParentMessage(raw);
    if (msg === null) {
      console.error('[vidroom] 忽略格式不对的父进程消息');
      return;
    }
    const secrets = msg.apiKey ? [msg.apiKey] : [];
    if (host === null) {
      // 第一条 set-key 到了才起服务,页面第一次查状态时 key 已就位
      host = await startHost({ model: modelFor(msg.apiKey), webDir, port, secrets });
      send({ type: 'ready', launchUrl: host.launchUrl });
    } else {
      host.setModel(modelFor(msg.apiKey), secrets);
    }
    send({ type: 'key-applied', hasApiKey: msg.apiKey !== null });
  };
  // 消息按到达顺序逐条处理,免得两条 set-key 同时起两个服务
  let queue = Promise.resolve();
  process.on('message', (raw) => {
    queue = queue.then(() => handle(raw)).catch((err) => {
      console.error('[vidroom] 处理父进程消息出错:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  });
  process.on('disconnect', () => process.exit(0));
} else {
  const apiKey = loadDeepSeekKey();
  const host = await startHost({ model: modelFor(apiKey), webDir, port, secrets: apiKey ? [apiKey] : [] });

  if (!apiKey) {
    console.log(`[vidroom] 没有配置 DeepSeek API key(环境变量 ${KEY_FILE_ENV} 未设置或文件不存在),聊天功能不可用。`);
  }
  console.log(`[vidroom] 启动地址(只能用一次): ${host.launchUrl}`);

  const shutdown = () => {
    host.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
