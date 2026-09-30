import { describe, expect, it } from 'vitest';
import { parseParentMessage } from '../src/parent-ipc.js';

describe('parseParentMessage', () => {
  it('set-key 带 key 或 null', () => {
    expect(parseParentMessage({ type: 'set-key', apiKey: ' sk-1 ' })).toEqual({ type: 'set-key', apiKey: 'sk-1' });
    expect(parseParentMessage({ type: 'set-key', apiKey: null })).toEqual({ type: 'set-key', apiKey: null });
  });

  it('其它一律不认', () => {
    for (const raw of [null, 'set-key', { type: 'other', apiKey: 'x' }, { type: 'set-key' }, { type: 'set-key', apiKey: '  ' }, { type: 'set-key', apiKey: 42 }]) {
      expect(parseParentMessage(raw)).toBeNull();
    }
  });
});
