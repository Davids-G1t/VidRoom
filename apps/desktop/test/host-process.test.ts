import { describe, expect, it } from 'vitest';
import { sanitizeTestBaseURL } from '../src/host-process.js';

describe('sanitizeTestBaseURL', () => {
  it('放行回环地址', () => {
    expect(sanitizeTestBaseURL('http://127.0.0.1:4321')).toBe('http://127.0.0.1:4321');
    expect(sanitizeTestBaseURL('http://localhost:4321')).toBe('http://localhost:4321');
    expect(sanitizeTestBaseURL('http://[::1]:4321')).toBe('http://[::1]:4321');
  });

  it('未设置时返回 undefined', () => {
    expect(sanitizeTestBaseURL(undefined)).toBeUndefined();
    expect(sanitizeTestBaseURL('')).toBeUndefined();
  });

  it('非回环地址一律丢弃(防打包版被环境变量劫持到任意地址)', () => {
    expect(sanitizeTestBaseURL('https://evil.example.com')).toBeUndefined();
    expect(sanitizeTestBaseURL('http://192.168.1.1:8080')).toBeUndefined();
    expect(sanitizeTestBaseURL('http://api.deepseek.com')).toBeUndefined();
  });

  it('解析失败的值一律丢弃', () => {
    expect(sanitizeTestBaseURL('not a url')).toBeUndefined();
  });
});
