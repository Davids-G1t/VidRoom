import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ComfyManager } from '../src/comfyui/manager.js';
import { ComfyProcess } from '../src/comfyui/process.js';
import { resolveComfyInstall } from '../src/comfyui/install.js';

/**
 * 用假 ComfyUI(fixtures/fake-comfyui/main.py,只用 Python 标准库)测 Host 这边的起停逻辑:
 * 引导代码、空闲端口、只绑 127.0.0.1、轮询就绪、停止、Host 被强杀后不留孤儿。
 * 需要 PATH 上有 Python(Linux 默认 python3,Windows 默认 python;可用 VIDROOM_TEST_PYTHON 指定)。
 */

const hostDir = fileURLToPath(new URL('..', import.meta.url));
const fakeDir = fileURLToPath(new URL('./fixtures/fake-comfyui', import.meta.url));
const python = process.env.VIDROOM_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const install = { comfyDir: fakeDir, python, source: 'local' as const };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  while (isAlive(pid)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`pid ${pid} ${timeoutMs} 毫秒后还活着`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return Date.now() - t0;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: 3_000 });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.once('timeout', () => (s.destroy(), resolve(false)));
  });
}

const lanIPv4 = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

describe('ComfyProcess(假 ComfyUI)', () => {
  it('随机端口起来、/system_stats 就绪、只听 127.0.0.1;停止时走 ComfyUI 自己的退出流程', async () => {
    const proc = await ComfyProcess.start({ install });
    try {
      const stats = await proc.systemStats();
      const argv = stats.system.argv as string[];
      expect(argv.slice(argv.indexOf('--listen'), argv.indexOf('--listen') + 2)).toEqual(['--listen', '127.0.0.1']);
      expect(argv).toContain('--disable-auto-launch');
      expect(argv[argv.indexOf('--port') + 1]).toBe(String(proc.port));
      expect(proc.port).not.toBe(8188);
      expect(await canConnect('127.0.0.1', proc.port)).toBe(true);
      if (lanIPv4) expect(await canConnect(lanIPv4, proc.port)).toBe(false);
    } finally {
      const r = await proc.stop();
      console.log(`[stop] ${process.platform}: ${JSON.stringify(r)}`);
      expect(r.graceful).toBe(true);
      expect(proc.output()).toContain('Stopped server');
    }
    expect(isAlive(proc.pid)).toBe(false);
  }, 60_000);

  it('ComfyUI 不肯退:宽限期过后强杀,如实报告不是正常退出', async () => {
    const prev = process.env.FAKE_COMFY_IGNORE_STOP;
    process.env.FAKE_COMFY_IGNORE_STOP = '1';
    try {
      const proc = await ComfyProcess.start({ install });
      const r = await proc.stop(1_000);
      expect(r.graceful).toBe(false);
      expect(r.code).not.toBe(0);
      expect(isAlive(proc.pid)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.FAKE_COMFY_IGNORE_STOP;
      else process.env.FAKE_COMFY_IGNORE_STOP = prev;
    }
  }, 60_000);

  it('Host 被强杀(不给它清理的机会):ComfyUI 发现 stdin 断了自己退出,30 秒内不留孤儿', async () => {
    const host = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/spawn-comfy.ts', fakeDir, python], {
      cwd: hostDir,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const comfyPid = await new Promise<number>((resolve, reject) => {
      let out = '';
      host.stdout!.on('data', (d) => {
        out += d;
        const m = /COMFY_PID=(\d+)/.exec(out);
        if (m) resolve(Number(m[1]));
      });
      host.once('exit', (code) => reject(new Error(`假 Host 提前退出 ${code}:${out}`)));
    });
    expect(isAlive(comfyPid)).toBe(true);
    host.kill('SIGKILL'); // Windows 上即 TerminateProcess
    const ms = await waitDead(comfyPid, 30_000);
    console.log(`[orphan] Host 被强杀后 ${ms} 毫秒 ComfyUI 退出`);
  }, 60_000);
});

describe('信号在两个平台上的实际行为', () => {
  it('SIGTERM:Linux 上进程能收到并自己收尾;Windows 上等同强杀,处理器根本不跑', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'vidroom-sig-')), 'handled');
    const code = `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((r) => child.stdout!.once('data', () => r()));
    const exited = new Promise<[number | null, string | null]>((r) => child.once('exit', (c, s) => r([c, s])));
    child.kill('SIGTERM');
    const [c, s] = await exited;
    console.log(`[sigterm] ${process.platform}: code=${c} signal=${s} 处理器跑了=${existsSync(marker)}`);
    expect(existsSync(marker)).toBe(process.platform !== 'win32');
  });
});

describe('ComfyManager', () => {
  it('start → running(带端口、版本检查);stop → stopped,进程不在', async () => {
    const m = new ComfyManager({ resolveInstall: async () => install, log: () => {} });
    expect(m.status()).toEqual({ state: 'stopped' });
    await m.start();
    const s = m.status();
    expect(s.state).toBe('running');
    if (s.state !== 'running') return;
    expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    expect(s.versions).toMatchObject({ comfyuiVersion: '0.38.0', torchCuda: '13.0', ok: true });
    const pid = m.process!.pid;
    await m.stop();
    expect(m.status()).toEqual({ state: 'stopped' });
    expect(isAlive(pid)).toBe(false);
  }, 60_000);

  it('找不到 ComfyUI:进 error 状态并带上原因', async () => {
    const m = new ComfyManager({ log: () => {}, resolveInstall: (o) => resolveComfyInstall({ ...o, env: {}, platform: 'linux' }) });
    await m.start();
    expect(m.status()).toMatchObject({ state: 'error', message: expect.stringContaining('VIDROOM_COMFYUI_DIR') });
  });
});
