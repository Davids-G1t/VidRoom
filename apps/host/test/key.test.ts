import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEY_FILE_ENV, loadDeepSeekKey } from '../src/key.js';

describe('loadDeepSeekKey', () => {
  it('环境变量没设 → null', () => {
    expect(loadDeepSeekKey({})).toBeNull();
  });

  it('文件不存在 → null', () => {
    expect(loadDeepSeekKey({ [KEY_FILE_ENV]: join(tmpdir(), 'vidroom-no-such-key-file') })).toBeNull();
  });

  it('读文件并去掉首尾空白;空文件 → null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vidroom-key-'));
    const file = join(dir, 'key');
    writeFileSync(file, 'sk-test-123\n');
    expect(loadDeepSeekKey({ [KEY_FILE_ENV]: file })).toBe('sk-test-123');
    writeFileSync(file, '  \n');
    expect(loadDeepSeekKey({ [KEY_FILE_ENV]: file })).toBeNull();
  });
});
