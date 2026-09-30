import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { envWithoutKey, startHostProcess } from './host';

/**
 * 浏览器里的「启动 / 打开 ComfyUI」:点「打开 ComfyUI」弹出的新页面地址必须是 http://127.0.0.1:<ComfyUI 端口>/。
 * 默认用假 ComfyUI(Python 标准库);环境里已设 VIDROOM_COMFYUI_DIR 时用那份真 ComfyUI
 * (再设 VIDROOM_COMFYUI_ARGS=--cpu 可不占显卡)。
 */
const fakeComfyDir = fileURLToPath(new URL('../apps/host/test/fixtures/fake-comfyui', import.meta.url));

test('点「打开 ComfyUI」打开的是 http://127.0.0.1:<端口>/;停掉 Host 后 ComfyUI 不残留', async ({ page }) => {
  test.setTimeout(300_000);
  const env = envWithoutKey();
  if (!env.VIDROOM_COMFYUI_DIR) {
    env.VIDROOM_COMFYUI_DIR = fakeComfyDir;
    env.VIDROOM_COMFYUI_PYTHON = env.VIDROOM_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  }
  const host = await startHostProcess(env);
  let comfyPid = 0;
  try {
    await page.goto(host.launchUrl);
    const panel = page.getByTestId('comfyui-panel');
    await expect(panel.getByTestId('comfyui-status')).toHaveText('未启动');
    await panel.getByRole('button', { name: '启动 ComfyUI' }).click();
    await expect(panel.getByTestId('comfyui-status')).toContainText('运行中', { timeout: 240_000 });

    const status = await (await page.request.get(`${host.origin}/api/comfyui`)).json();
    expect(status.state).toBe('running');
    const expected = `http://127.0.0.1:${status.port}/`;

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      panel.getByRole('button', { name: '打开 ComfyUI' }).click(),
    ]);
    await popup.waitForLoadState();
    expect(popup.url()).toBe(expected);
    console.log(`[comfyui] 弹出页地址 ${popup.url()},设备 ${status.devices.join(', ')}`);
    await page.screenshot({ path: 'test-results/comfyui-panel.png' });

    // ComfyUI 自报的启动参数里是回环地址 + 这个端口;pid 从操作系统按端口查,用来核对 Host 退出后它也不在了
    const stats = await (await page.request.get(`http://127.0.0.1:${status.port}/system_stats`)).json();
    expect(stats.system.argv).toEqual(expect.arrayContaining(['--listen', '127.0.0.1', '--port', String(status.port)]));
    comfyPid = pidListening(status.port);
  } finally {
    await host.stop();
  }
  if (comfyPid) {
    const t0 = Date.now();
    await expect.poll(() => alive(comfyPid), { timeout: 30_000 }).toBe(false);
    console.log(`[comfyui] Host 退出后 ${Date.now() - t0} 毫秒 ComfyUI(pid ${comfyPid})已不在`);
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 监听某个端口的进程 pid(Linux 用 ss,Windows 用 Get-NetTCPConnection) */
function pidListening(port: number): number {
  const out =
    process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port}).OwningProcess`], { encoding: 'utf8' })
      : (/pid=(\d+)/.exec(execFileSync('ss', ['-tlnpH', `sport = :${port}`], { encoding: 'utf8' }))?.[1] ?? '');
  const pid = Number(out.trim().split(/\s+/)[0]);
  expect(pid).toBeGreaterThan(0);
  return pid;
}
