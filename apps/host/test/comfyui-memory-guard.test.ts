import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ComfyManager, MEMORY_LIMIT_ENV, defaultMemoryLimitMiB } from '../src/comfyui/manager.js';
import { BOOTSTRAP, ComfyProcess, MEMORY_LIMIT_EXIT_CODE } from '../src/comfyui/process.js';

/**
 * Windows 内存护栏:作业对象(Job Object)给 ComfyUI 整组进程套内存上限,超了只结束 ComfyUI,Host 不受影响。
 * 真正的验证只能在 Windows 上跑(CI 的 windows-latest):假 ComfyUI 故意一直吃内存(FAKE_COMFY_EAT_MEMORY_MB)。
 * Linux 上只核对引导代码是合法 Python、默认上限怎么算。
 */

const fakeDir = fileURLToPath(new URL('./fixtures/fake-comfyui', import.meta.url));
const python = process.env.VIDROOM_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const install = { comfyDir: fakeDir, python, source: 'local' as const };
const GiB = 2 ** 30;

describe('内存上限默认值', () => {
  it('物理内存减 4 GiB,至少 4 GiB;环境变量可改,0 = 不设', () => {
    expect(defaultMemoryLimitMiB(32 * GiB, {})).toBe(28 * 1024);
    expect(defaultMemoryLimitMiB(6 * GiB, {})).toBe(4096);
    expect(defaultMemoryLimitMiB(32 * GiB, { [MEMORY_LIMIT_ENV]: '12000' })).toBe(12000);
    expect(defaultMemoryLimitMiB(32 * GiB, { [MEMORY_LIMIT_ENV]: '0' })).toBe(0);
    expect(defaultMemoryLimitMiB(32 * GiB, { [MEMORY_LIMIT_ENV]: 'abc' })).toBe(28 * 1024);
  });
});

describe('引导代码', () => {
  it('是能编译的 Python(含作业对象护栏)', () => {
    const r = spawnSync(python, ['-c', 'import sys; compile(sys.stdin.read(), "<bootstrap>", "exec")'], {
      input: BOOTSTRAP,
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(BOOTSTRAP).toContain('_job_memory_guard()');
  });
});

describe.runIf(process.platform === 'win32')('Windows 作业对象内存上限(假 ComfyUI 吃内存)', () => {
  it('超过上限:只结束 ComfyUI(退出码 87),Host 进程照常', async () => {
    const prev = process.env.FAKE_COMFY_EAT_MEMORY_MB;
    process.env.FAKE_COMFY_EAT_MEMORY_MB = '50';
    try {
      const proc = await ComfyProcess.start({ install, memoryLimitMiB: 400 });
      const t0 = Date.now();
      await Promise.race([proc.exited, new Promise((_, rej) => setTimeout(() => rej(new Error('60 秒内没被结束')), 60_000))]);
      console.log(`[memory-guard] ComfyUI 在 ${Date.now() - t0} 毫秒后退出,退出码 ${proc.exitCode}`);
      console.log(proc.output().split('\n').filter((l) => l.includes('[vidroom]') || l.includes('已占')).slice(-4).join('\n'));
      expect(proc.exitCode).toBe(MEMORY_LIMIT_EXIT_CODE);
      expect(proc.output()).toContain('内存上限 400 MiB');
      expect(proc.output()).toContain('内存超过上限');
      // 测试进程(扮演 Host)还活着、还能干活
      expect(process.memoryUsage().rss).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.FAKE_COMFY_EAT_MEMORY_MB;
      else process.env.FAKE_COMFY_EAT_MEMORY_MB = prev;
    }
  }, 90_000);

  it('ComfyManager 报告「内存超过上限被结束」,之后还能重新启动', async () => {
    process.env.FAKE_COMFY_EAT_MEMORY_MB = '50';
    const logs: string[] = [];
    const m = new ComfyManager({ resolveInstall: async () => install, memoryLimitMiB: 400, log: (l) => logs.push(l) });
    try {
      await m.start();
      await expect.poll(() => m.status().state, { timeout: 60_000 }).toBe('error');
      const st = m.status();
      expect(st.state === 'error' && st.message).toContain('内存超过上限');
      delete process.env.FAKE_COMFY_EAT_MEMORY_MB;
      await m.start();
      expect(m.status().state).toBe('running');
    } finally {
      delete process.env.FAKE_COMFY_EAT_MEMORY_MB;
      await m.stop();
    }
  }, 120_000);
});
