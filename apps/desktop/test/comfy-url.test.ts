import { describe, expect, it } from 'vitest';
import { comfyUrlFromStatus } from '../src/comfy-url.js';

describe('comfyUrlFromStatus', () => {
  it('运行中:只用端口拼回环地址', () => {
    expect(comfyUrlFromStatus({ state: 'running', port: 43611, url: 'http://evil.example' })).toBe('http://127.0.0.1:43611/');
  });

  it('没在跑或端口不对:null', () => {
    for (const s of [null, 'x', { state: 'stopped' }, { state: 'running' }, { state: 'running', port: '80' }, { state: 'running', port: 0 }, { state: 'running', port: 70000 }, { state: 'running', port: 1.5 }]) {
      expect(comfyUrlFromStatus(s)).toBeNull();
    }
  });
});
