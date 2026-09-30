import { readFileSync } from 'node:fs';
import { isLlmProvider, type LlmProvider } from './llm-provider.js';

export const KEY_FILE_ENV = 'VIDROOM_DEEPSEEK_KEY_FILE';
export const ANTHROPIC_KEY_FILE_ENV = 'VIDROOM_ANTHROPIC_KEY_FILE';
/** 命令行开发时选哪家 LLM:deepseek(默认)或 anthropic */
export const PROVIDER_ENV = 'VIDROOM_LLM_PROVIDER';

export const KEY_FILE_ENVS: Record<LlmProvider, string> = { deepseek: KEY_FILE_ENV, anthropic: ANTHROPIC_KEY_FILE_ENV };
/** 只给测试把 LLM 请求指到本机假服务 */
export const BASE_URL_ENVS: Record<LlmProvider, string> = { deepseek: 'VIDROOM_DEEPSEEK_BASE_URL', anthropic: 'VIDROOM_ANTHROPIC_BASE_URL' };

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const v = env[PROVIDER_ENV]?.trim();
  return isLlmProvider(v) ? v : 'deepseek';
}

/**
 * 从环境变量给出的文件路径读某家 LLM 的 API key(DeepSeek:VIDROOM_DEEPSEEK_KEY_FILE,Anthropic:VIDROOM_ANTHROPIC_KEY_FILE)。
 * 环境变量没设、文件不存在或内容为空 → null(视为没配置 key)。
 * key 只留在内存里:不打印、不写日志、不进任何 HTTP 响应。
 */
export function loadKey(provider: LlmProvider, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env[KEY_FILE_ENVS[provider]];
  if (!path) return null;
  try {
    const key = readFileSync(path, 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}
