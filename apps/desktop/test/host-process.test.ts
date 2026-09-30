import { describe, expect, it } from 'vitest';
import { sanitizeDeepSeekBaseURL } from '../src/host-process.js';

describe('sanitizeDeepSeekBaseURL', () => {
  it('放行回环地址', () => {
    expect(sanitizeDeepSeekBaseURL('http://127.0.0.1:4321')).toBe('http://127.0.0.1:4321');
    expect(sanitizeDeepSeekBaseURL('http://localhost:4321')).toBe('http://localhost:4321');
    expect(sanitizeDeepSeekBaseURL('http://[::1]:4321')).toBe('http://[::1]:4321');
  });

  it('未设置时返回 undefined', () => {
    expect(sanitizeDeepSeekBaseURL(undefined)).toBeUndefined();
    expect(sanitizeDeepSeekBaseURL('')).toBeUndefined();
  });

  it('非回环地址一律丢弃(防打包版被环境变量劫持到任意地址)', () => {
    expect(sanitizeDeepSeekBaseURL('https://evil.example.com')).toBeUndefined();
    expect(sanitizeDeepSeekBaseURL('http://192.168.1.1:8080')).toBeUndefined();
    expect(sanitizeDeepSeekBaseURL('http://api.deepseek.com')).toBeUndefined();
  });

  it('解析失败的值一律丢弃', () => {
    expect(sanitizeDeepSeekBaseURL('not a url')).toBeUndefined();
  });
});
