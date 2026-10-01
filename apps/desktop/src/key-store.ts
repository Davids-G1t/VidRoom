import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLlmProvider, type LlmProvider } from '../../host/src/llm-provider.js';
import type { CloudKeyKind } from '../../host/src/parent-ipc.js';

/**
 * LLM API key(DeepSeek / Anthropic 各一份文件)的加密落盘,以及「当前用哪家」的选择。这个文件不 import electron,加解密函数由 main.ts 传入
 * (生产用 Electron safeStorage:Windows 上走 DPAPI),方便单测。
 *
 * 明文 key 只在主进程内存里短暂存在:解密后经 IPC 通道交给 Host 子进程。
 * 渲染进程(页面)只能「设置新 key」和「问有没有 key」,拿不到明文,也拿不到密文。
 */

export const KEY_FILE_NAME = 'deepseek-key.enc';
export const KEY_FILE_NAMES: Record<LlmProvider, string> = { deepseek: KEY_FILE_NAME, anthropic: 'anthropic-key.enc' };
/** 云端(生视频 / 生图)两家各一份,和 LLM key 同一个存法 */
export type { CloudKeyKind };
export const CLOUD_KEY_FILE_NAMES: Record<CloudKeyKind, string> = {
  video: 'cloud-video-key.enc',
  image: 'cloud-image-key.enc',
};
/** 一份 key 存哪:LLM 两家 + 云端两家 */
export type KeySlot = LlmProvider | `cloud-${CloudKeyKind}`;
export const SLOT_FILE_NAMES: Record<KeySlot, string> = {
  ...KEY_FILE_NAMES,
  'cloud-video': CLOUD_KEY_FILE_NAMES.video,
  'cloud-image': CLOUD_KEY_FILE_NAMES.image,
};
/** 当前选用哪家(不是秘密,明文 JSON) */
export const PROVIDER_FILE_NAME = 'llm-provider.json';

export function loadProvider(dir: string): LlmProvider {
  try {
    const p = (JSON.parse(readFileSync(join(dir, PROVIDER_FILE_NAME), 'utf8')) as { provider?: unknown }).provider;
    return isLlmProvider(p) ? p : 'deepseek';
  } catch {
    return 'deepseek';
  }
}

export function saveProvider(dir: string, provider: LlmProvider): void {
  const file = join(dir, PROVIDER_FILE_NAME);
  writeFileSync(`${file}.tmp`, JSON.stringify({ provider }));
  renameSync(`${file}.tmp`, file);
}

export interface Cipher {
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export const MAX_KEY_LENGTH = 512;

/** 页面传来的 key:去掉首尾空白后非空、不超长、不含空白和控制字符。合法返回规整后的 key,否则 null。 */
export function normalizeKeyInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return null;
  return key;
}

export class KeyStore {
  readonly file: string;

  constructor(
    dir: string,
    private readonly cipher: Cipher,
    private readonly log: (msg: string) => void = console.warn,
    readonly slot: KeySlot = 'deepseek',
  ) {
    this.file = join(dir, SLOT_FILE_NAMES[slot]);
  }

  has(): boolean {
    return existsSync(this.file);
  }

  /** 读并解密;没有文件或解密失败 → null(解密失败只记一行,不带文件内容) */
  load(): string | null {
    if (!this.has()) return null;
    try {
      const key = this.cipher.decrypt(readFileSync(this.file));
      return normalizeKeyInput(key);
    } catch {
      this.log(`[vidroom-desktop] ${SLOT_FILE_NAMES[this.slot]} 解密失败(换了系统账户或文件损坏),当作没有配置 key`);
      return null;
    }
  }

  /** 加密后原子写入(先写临时文件再改名),不留半截文件 */
  save(key: string): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, this.cipher.encrypt(key), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
