import { readFileSync } from 'node:fs';

export const KEY_FILE_ENV = 'VIDROOM_DEEPSEEK_KEY_FILE';

/**
 * 从环境变量给出的文件路径读 DeepSeek API key。
 * 环境变量没设、文件不存在或内容为空 → null(视为没配置 key)。
 * key 只留在内存里:不打印、不写日志、不进任何 HTTP 响应。
 */
export function loadDeepSeekKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env[KEY_FILE_ENV];
  if (!path) return null;
  try {
    const key = readFileSync(path, 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}
