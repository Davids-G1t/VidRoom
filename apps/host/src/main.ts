import { fileURLToPath } from 'node:url';
import { createDeepSeekModel } from './agent.js';
import { KEY_FILE_ENV, loadDeepSeekKey } from './key.js';
import { startHost } from './server.js';

const apiKey = loadDeepSeekKey();
const webDir = process.env.VIDROOM_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const port = Number(process.env.VIDROOM_PORT ?? 0);

const host = await startHost({
  model: apiKey ? createDeepSeekModel(apiKey) : null,
  webDir,
  port,
  secrets: apiKey ? [apiKey] : [],
});

if (!apiKey) {
  console.log(`[vidroom] 没有配置 DeepSeek API key(环境变量 ${KEY_FILE_ENV} 未设置或文件不存在),聊天功能不可用。`);
}
console.log(`[vidroom] 启动地址(只能用一次): ${host.launchUrl}`);

const shutdown = () => {
  host.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
