import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NVIDIA_SMI_ARGS, classifyTier, parseNvidiaSmi, probeGpu, resultFromOutput } from '../src/gpu.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('显卡分档:5 种 nvidia-smi 输出样本', () => {
  it('没有 NVIDIA 显卡(命令不存在)→ none', async () => {
    const r = await probeGpu(async () => null);
    expect(r).toMatchObject({ hasNvidiaGpu: false, primary: null, gpus: [], tier: 'none' });
  });

  it('没有 NVIDIA 显卡:报错文字即便被当输出拿到,也解析不出显卡 → none', () => {
    const r = resultFromOutput(fixture('nvidia-smi-none.txt'));
    expect(r.tier).toBe('none');
    expect(r.hasNvidiaGpu).toBe(false);
  });

  it('8GB → unsupported', async () => {
    const r = await probeGpu(async () => fixture('nvidia-smi-8gb-rtx4060.txt'));
    expect(r.primary).toEqual({ name: 'NVIDIA GeForce RTX 4060', memoryMiB: 8188, memoryGiB: 8 });
    expect(r.tier).toBe('unsupported');
  });

  it('12GB → unsupported', async () => {
    const r = await probeGpu(async () => fixture('nvidia-smi-12gb-rtx3060.txt'));
    expect(r.primary).toEqual({ name: 'NVIDIA GeForce RTX 3060', memoryMiB: 12288, memoryGiB: 12 });
    expect(r.tier).toBe('unsupported');
  });

  it('16GB(4060 Ti 实录,报 16380 MiB)→ experimental', async () => {
    const r = await probeGpu(async () => fixture('nvidia-smi-16gb-rtx4060ti.txt'));
    expect(r.primary).toEqual({ name: 'NVIDIA GeForce RTX 4060 Ti', memoryMiB: 16380, memoryGiB: 16 });
    expect(r.tier).toBe('experimental');
  });

  it('24GB(4090 报 24564 MiB,略少于 24576)→ default', async () => {
    const r = await probeGpu(async () => fixture('nvidia-smi-24gb-rtx4090.txt'));
    expect(r.primary).toEqual({ name: 'NVIDIA GeForce RTX 4090', memoryMiB: 24564, memoryGiB: 24 });
    expect(r.tier).toBe('default');
  });
});

describe('分档边界与解析细节', () => {
  it('阈值按整 GiB:<15 unsupported,15–23 experimental,≥24 default', () => {
    expect(classifyTier(null)).toBe('none');
    expect(classifyTier(14 * 1024)).toBe('unsupported');
    expect(classifyTier(15 * 1024)).toBe('experimental');
    expect(classifyTier(23 * 1024)).toBe('experimental');
    expect(classifyTier(24 * 1024)).toBe('default');
    expect(classifyTier(48 * 1024)).toBe('default');
  });

  it('多卡取显存最大的一张分档;Windows 换行也能解析', () => {
    const r = resultFromOutput('NVIDIA GeForce RTX 3060, 12288\r\nNVIDIA GeForce RTX 3090, 24576\r\n');
    expect(r.gpus).toHaveLength(2);
    expect(r.primary?.name).toBe('NVIDIA GeForce RTX 3090');
    expect(r.tier).toBe('default');
  });

  it('空输出与乱码行被忽略', () => {
    expect(parseNvidiaSmi('')).toEqual([]);
    expect(parseNvidiaSmi('garbage\nNVIDIA X, [N/A]\n')).toEqual([]);
  });
});

describe('真实调用 nvidia-smi(不 mock)', () => {
  it('与独立跑一次 nvidia-smi 的结果一致;没有这个命令的机器(如 CI)判 none', async () => {
    const r = await probeGpu();
    const truth = spawnSync('nvidia-smi', [...NVIDIA_SMI_ARGS], { encoding: 'utf8', windowsHide: true });
    const hasSmi = truth.error === undefined && truth.status === 0;
    console.log(`[real nvidia-smi] hasSmi=${hasSmi} tier=${r.tier} primary=${JSON.stringify(r.primary)}`);
    if (!hasSmi) {
      expect(r.tier).toBe('none');
      expect(r.hasNvidiaGpu).toBe(false);
      return;
    }
    const [first] = parseNvidiaSmi(truth.stdout);
    expect(r.hasNvidiaGpu).toBe(true);
    expect(r.gpus[0]).toEqual(first);
    expect(r.tier).toBe(classifyTier(r.primary!.memoryMiB));
  });
});
