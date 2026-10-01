import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_KEY_FILE_ENV, KEY_FILE_ENV, PROVIDER_ENV, loadKey, providerFromEnv } from '../src/key.js';

describe('loadKey', () => {
  it('环境变量没设 → null', () => {
    expect(loadKey('deepseek', {})).toBeNull();
    expect(loadKey('anthropic', {})).toBeNull();
  });

  it('文件不存在 → null', () => {
    expect(loadKey('deepseek', { [KEY_FILE_ENV]: join(tmpdir(), 'vidroom-no-such-key-file') })).toBeNull();
  });

  it('读文件并去掉首尾空白;空文件 → null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vidroom-key-'));
    const file = join(dir, 'key');
    writeFileSync(file, 'sk-test-123\n');
    expect(loadKey('deepseek', { [KEY_FILE_ENV]: file })).toBe('sk-test-123');
    writeFileSync(file, '  \n');
    expect(loadKey('deepseek', { [KEY_FILE_ENV]: file })).toBeNull();
  });

  it('各家读各自的环境变量,不串', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vidroom-key-'));
    const file = join(dir, 'anthropic-key');
    writeFileSync(file, 'sk-ant-test');
    expect(loadKey('anthropic', { [ANTHROPIC_KEY_FILE_ENV]: file })).toBe('sk-ant-test');
    expect(loadKey('deepseek', { [ANTHROPIC_KEY_FILE_ENV]: file })).toBeNull();
  });
});

describe('providerFromEnv', () => {
  it('默认 deepseek;认得 anthropic;不认得的值当默认', () => {
    expect(providerFromEnv({})).toBe('deepseek');
    expect(providerFromEnv({ [PROVIDER_ENV]: 'anthropic' })).toBe('anthropic');
    expect(providerFromEnv({ [PROVIDER_ENV]: 'openai' })).toBe('deepseek');
  });
});
