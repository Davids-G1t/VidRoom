import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DeepSeek key 的加密落盘。这个文件不 import electron,加解密函数由 main.ts 传入
 * (生产用 Electron safeStorage:Windows 上走 DPAPI),方便单测。
 *
 * 明文 key 只在主进程内存里短暂存在:解密后经 IPC 通道交给 Host 子进程。
 * 渲染进程(页面)只能「设置新 key」和「问有没有 key」,拿不到明文,也拿不到密文。
 */

export const KEY_FILE_NAME = 'deepseek-key.enc';

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
  ) {
    this.file = join(dir, KEY_FILE_NAME);
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
      this.log(`[vidroom-desktop] ${KEY_FILE_NAME} 解密失败(换了系统账户或文件损坏),当作没有配置 key`);
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
