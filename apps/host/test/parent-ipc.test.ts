import { describe, expect, it } from 'vitest';
import { parseParentMessage } from '../src/parent-ipc.js';

describe('parseParentMessage', () => {
  it('set-key 带 provider 和 key 或 null', () => {
    expect(parseParentMessage({ type: 'set-key', provider: 'deepseek', apiKey: ' sk-1 ' })).toEqual({ type: 'set-key', provider: 'deepseek', apiKey: 'sk-1' });
    expect(parseParentMessage({ type: 'set-key', provider: 'anthropic', apiKey: 'sk-ant' })).toEqual({ type: 'set-key', provider: 'anthropic', apiKey: 'sk-ant' });
    expect(parseParentMessage({ type: 'set-key', provider: 'deepseek', apiKey: null })).toEqual({ type: 'set-key', provider: 'deepseek', apiKey: null });
  });

  it('其它一律不认', () => {
    for (const raw of [
      null,
      'set-key',
      { type: 'other', provider: 'deepseek', apiKey: 'x' },
      { type: 'set-key', provider: 'deepseek' },
      { type: 'set-key', provider: 'deepseek', apiKey: '  ' },
      { type: 'set-key', provider: 'deepseek', apiKey: 42 },
      { type: 'set-key', apiKey: 'x' },
      { type: 'set-key', provider: 'openai', apiKey: 'x' },
    ]) {
      expect(parseParentMessage(raw)).toBeNull();
    }
  });
});
