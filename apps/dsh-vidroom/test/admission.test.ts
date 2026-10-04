/** 显存准入:不到 24 GiB 要显式放行。 */
import { describe, expect, it } from 'vitest';
import { H3_EXPERIMENTAL_ENV, gpuTier, h3Admission } from '../src/admission.js';

describe('显存准入', () => {
  it('显存分档', () => {
    expect(gpuTier(24)).toBe('default');
    expect(gpuTier(32)).toBe('default');
    expect(gpuTier(16)).toBe('experimental');
    expect(gpuTier(15)).toBe('experimental');
    expect(gpuTier(8)).toBe('unsupported');
    expect(gpuTier(undefined)).toBe('unknown');
    expect(gpuTier(Number.NaN)).toBe('unknown');
  });

  it('默认档放行', () => {
    const admission = h3Admission(24, false);
    expect(admission.allowed).toBe(true);
    expect(admission.tier).toBe('default');
    expect(admission.reason).toMatch(/默认开启/);
  });

  it('实验档默认不放行,配置或环境变量开了才放行', () => {
    const closed = h3Admission(16, false, {});
    expect(closed.allowed).toBe(false);
    expect(closed.tier).toBe('experimental');
    expect(closed.reason).toMatch(/实验功能/);

    expect(h3Admission(16, true, {}).allowed).toBe(true);
    expect(h3Admission(16, true, {}).reason).toMatch(/已按实验档放行/);
    expect(h3Admission(16, false, { [H3_EXPERIMENTAL_ENV]: '1' }).allowed).toBe(true);
    expect(h3Admission(16, false, { [H3_EXPERIMENTAL_ENV]: '0' }).allowed).toBe(false);
  });

  it('显存读不到时不拦(ComfyUI 没报 device 时,真正的闸是 ComfyUI 自己),并把原因说清', () => {
    const admission = h3Admission(undefined, false, {});
    expect(admission.tier).toBe('unknown');
    expect(admission.allowed).toBe(true);
    expect(admission.reason).toMatch(/读不到显卡信息/);
  });

  it('显存太小(不到 15 GiB)不放行', () => {
    const admission = h3Admission(10, true, {});
    expect(admission.allowed).toBe(false);
    expect(admission.tier).toBe('unsupported');
  });
});
