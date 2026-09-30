import { describe, expect, it, vi } from 'vitest';
import { assertTrustedSender, isAppUrl, isTrustedSender, UntrustedSenderError, type FrameLike } from '../src/trust.js';

const top = (url: string): FrameLike => ({ url, parent: null });

describe('isAppUrl', () => {
  it('只认 vidroom-app://app/', () => {
    expect(isAppUrl('vidroom-app://app/index.html')).toBe(true);
    expect(isAppUrl('vidroom-app://app/')).toBe(true);
    expect(isAppUrl('vidroom-app://evil/index.html')).toBe(false);
    expect(isAppUrl('http://127.0.0.1:1234/')).toBe(false);
    expect(isAppUrl('file:///C:/index.html')).toBe(false);
    expect(isAppUrl('https://app/')).toBe(false);
    expect(isAppUrl('not a url')).toBe(false);
    expect(isAppUrl('')).toBe(false);
  });
});

describe('isTrustedSender', () => {
  it('本应用顶层页面 → 可信', () => {
    expect(isTrustedSender({ senderFrame: top('vidroom-app://app/index.html') })).toBe(true);
  });

  it('子框架即使地址是本应用也不可信', () => {
    const child: FrameLike = { url: 'vidroom-app://app/index.html', parent: top('vidroom-app://app/index.html') };
    expect(isTrustedSender({ senderFrame: child })).toBe(false);
  });

  it('外部页面、框架已销毁 → 不可信', () => {
    expect(isTrustedSender({ senderFrame: top('https://example.com/') })).toBe(false);
    expect(isTrustedSender({ senderFrame: null })).toBe(false);
  });
});

describe('assertTrustedSender', () => {
  it('可信 → 不抛、不记日志', () => {
    const log = vi.fn();
    assertTrustedSender({ senderFrame: top('vidroom-app://app/index.html') }, 'ch', log);
    expect(log).not.toHaveBeenCalled();
  });

  it('不可信 → 抛错并记一行日志(带通道名和来源)', () => {
    const log = vi.fn();
    expect(() => assertTrustedSender({ senderFrame: top('https://example.com/') }, 'vidroom:set-key', log)).toThrow(
      UntrustedSenderError,
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('vidroom:set-key');
    expect(log.mock.calls[0][0]).toContain('https://example.com/');
  });
});
