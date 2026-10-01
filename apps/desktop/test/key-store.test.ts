import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { KEY_FILE_NAME, KEY_FILE_NAMES, KeyStore, MAX_KEY_LENGTH, PROVIDER_FILE_NAME, loadProvider, normalizeKeyInput, saveProvider, type Cipher } from '../src/key-store.js';

// 假加密:每个字节异或 0x5a。真加密(safeStorage / DPAPI)只能在 Windows CI 的 e2e 里验
const fakeCipher: Cipher = {
  encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString('utf8'),
};

const tempDir = () => mkdtempSync(join(tmpdir(), 'vidroom-keystore-'));

describe('normalizeKeyInput', () => {
  it('去首尾空白;空、超长、非字符串、含空白或控制字符 → null', () => {
    expect(normalizeKeyInput('  sk-abc  ')).toBe('sk-abc');
    expect(normalizeKeyInput('')).toBeNull();
    expect(normalizeKeyInput('   ')).toBeNull();
    expect(normalizeKeyInput('sk a')).toBeNull();
    expect(normalizeKeyInput('sk\na')).toBeNull();
    expect(normalizeKeyInput('sk\u0000a')).toBeNull();
    expect(normalizeKeyInput('x'.repeat(MAX_KEY_LENGTH + 1))).toBeNull();
    expect(normalizeKeyInput(123)).toBeNull();
    expect(normalizeKeyInput(undefined)).toBeNull();
  });
});

describe('KeyStore', () => {
  it('存了再读回来一致;落盘的是加密器的输出,文件里查不到明文', () => {
    const dir = tempDir();
    const store = new KeyStore(dir, fakeCipher);
    expect(store.has()).toBe(false);
    expect(store.load()).toBeNull();

    store.save('sk-plain-text-key');
    expect(store.has()).toBe(true);
    expect(readdirSync(dir)).toEqual([KEY_FILE_NAME]); // 临时文件已改名,不留尾巴
    expect(readFileSync(join(dir, KEY_FILE_NAME)).includes('sk-plain-text-key')).toBe(false);
    expect(new KeyStore(dir, fakeCipher).load()).toBe('sk-plain-text-key');
  });

  it('解密失败 → 当作没有 key,日志里不带文件内容', () => {
    const dir = tempDir();
    writeFileSync(join(dir, KEY_FILE_NAME), 'garbage-content');
    const log = vi.fn();
    const store = new KeyStore(dir, { encrypt: fakeCipher.encrypt, decrypt: () => { throw new Error('bad'); } }, log);
    expect(store.load()).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).not.toContain('garbage-content');
  });
});

describe('多家 key 与当前选择', () => {
  it('DeepSeek 与 Anthropic 各存各的文件,互不覆盖', () => {
    const dir = tempDir();
    new KeyStore(dir, fakeCipher, undefined, 'deepseek').save('sk-deepseek');
    new KeyStore(dir, fakeCipher, undefined, 'anthropic').save('sk-ant-key');
    expect(readdirSync(dir).sort()).toEqual([KEY_FILE_NAMES.anthropic, KEY_FILE_NAMES.deepseek].sort());
    expect(new KeyStore(dir, fakeCipher, undefined, 'deepseek').load()).toBe('sk-deepseek');
    expect(new KeyStore(dir, fakeCipher, undefined, 'anthropic').load()).toBe('sk-ant-key');
  });

  it('当前选择:默认 deepseek;存了 anthropic 读回 anthropic;文件坏了回到默认', () => {
    const dir = tempDir();
    expect(loadProvider(dir)).toBe('deepseek');
    saveProvider(dir, 'anthropic');
    expect(loadProvider(dir)).toBe('anthropic');
    writeFileSync(join(dir, PROVIDER_FILE_NAME), '{"provider":"openai"}');
    expect(loadProvider(dir)).toBe('deepseek');
  });
});
