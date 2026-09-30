import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startFakeLlm, type FakeLlm } from './fake-llm';

/**
 * 桌面版端到端(Playwright 驱动 Electron)。
 * - 设了 VIDROOM_DESKTOP_EXE:驱动装好的 VidRoom.exe(CI 上先 /S 静默安装再跑);
 * - 没设:驱动仓库里的开发版(先 `pnpm build`)。
 * 用假 key + 假 LLM 服务,不调真 DeepSeek。
 */

const desktopDir = fileURLToPath(new URL('../apps/desktop/', import.meta.url));
const FAKE_KEY = 'fake-deepseek-key-for-e2e-0123456789';
const shots = (name: string) => `test-results/desktop-${name}.png`;

// 本机调试用的额外 Electron 参数(例如 Linux 上无桌面时 --ozone-platform=headless),CI 不设
const extraArgs = (process.env.VIDROOM_E2E_ELECTRON_ARGS ?? '').split(' ').filter(Boolean);

interface Launched {
  app: ElectronApplication;
  page: Page;
  hostPid: () => Promise<number>;
  exited: Promise<void>;
}

async function launch(userDataDir: string, fake: FakeLlm): Promise<Launched> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.VIDROOM_DEEPSEEK_KEY_FILE;
  delete env.ELECTRON_RUN_AS_NODE;
  env.VIDROOM_USER_DATA_DIR = userDataDir;
  env.VIDROOM_DEEPSEEK_BASE_URL = fake.baseURL;

  const exe = process.env.VIDROOM_DESKTOP_EXE;
  const app = exe
    ? await electron.launch({ executablePath: exe, args: extraArgs, env })
    : await electron.launch({
        executablePath: createRequire(join(desktopDir, 'package.json'))('electron') as unknown as string,
        args: [desktopDir, ...extraArgs],
        env,
      });

  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  const page = await app.firstWindow();
  const hostPid = async () => {
    let pid: number | null = null;
    try {
      await expect.poll(() => (pid = findHostPid(app.process().pid!)), { timeout: 30_000 }).not.toBeNull();
    } catch (err) {
      console.log(`[diag] 主进程 pid=${app.process().pid}\n${processTable()}`);
      throw err;
    }
    return pid!;
  };
  return { app, page, hostPid, exited };
}

/** 找不到 Host 时打印进程表,便于排查 */
function processTable(): string {
  if (process.platform === 'win32') {
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*VidRoom*' } | Format-List ProcessId, ParentProcessId, CommandLine`,
      ],
      { encoding: 'utf8' },
    );
    return r.stdout + r.stderr;
  }
  return spawnSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8' }).stdout;
}

/** 从操作系统里找 Host:主进程的子进程里,命令行带 host.mjs 的那个 */
function findHostPid(parentPid: number): number | null {
  let out: string;
  if (process.platform === 'win32') {
    out = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        // 命令里不用双引号:Node 在 Windows 上转义参数时会把双引号改写,PowerShell 解析会出错
        `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} -and $_.CommandLine -like '*host.mjs*' } | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: 'utf8' },
    ).stdout;
  } else {
    out = spawnSync('pgrep', ['-P', String(parentPid), '-f', 'host\\.mjs'], { encoding: 'utf8' }).stdout;
  }
  const pids = out.split(/\s+/).filter(Boolean).map(Number);
  return pids.length === 1 ? pids[0] : null;
}

function isAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    // 合同原文:「退出后 Get-Process 里没有残留的 Host 进程」
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`],
      { encoding: 'utf8' },
    );
    return r.stdout.trim() !== '';
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Host 进程的命令行(Linux 上再加环境变量):key 只走 IPC 通道,这里不能出现 */
function hostProcessInfo(pid: number): string {
  if (process.platform === 'win32') {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${pid} }).CommandLine`],
      { encoding: 'utf8' },
    );
  }
  if (process.platform === 'linux') {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8') + '\n' + readFileSync(`/proc/${pid}/environ`, 'utf8');
  }
  return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
}

/** 关掉唯一的窗口(走正常关窗流程,不是强杀) */
async function closeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
}

/** ground truth:测试自己跑一次 nvidia-smi,跑不了就该是「没有 NVIDIA 显卡」那一档 */
function expectedGpuSummaryFragment(): string {
  const smi = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
    encoding: 'utf8',
  });
  return smi.status === 0 && smi.stdout.trim() ? '显存' : '没有检测到 NVIDIA 显卡';
}

test('桌面版:存假 key → 重启 → 聊天可用、显示显卡档位;有任务时关窗先问;退出后没有残留 Host', async () => {
  test.setTimeout(300_000);
  const fake = await startFakeLlm();
  const userDataDir = mkdtempSync(join(tmpdir(), 'vidroom-desktop-e2e-'));
  const keyFile = join(userDataDir, 'deepseek-key.enc');

  try {
    // ---------- 第一次启动:没有 key ----------
    const first = await launch(userDataDir, fake);
    const hostPid1 = await first.hostPid();
    const { page } = first;
    await expect(page).toHaveURL(/^vidroom-app:\/\/app\//);
    await expect(page.getByTestId('no-key-notice')).toBeVisible();
    await expect(page.getByTestId('preset-workflows')).toBeVisible();

    // 安全边界:页面里没有 Node,桥上只有两个函数;窗口的 webPreferences 如设计
    const surface = await page.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: Object.keys((window as unknown as { vidroom: object }).vidroom).sort(),
    }));
    expect(surface).toEqual({ require: 'undefined', process: 'undefined', bridge: ['getKeyStatus', 'setKey'] });
    const prefs = await first.app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { sandbox: p?.sandbox, contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration };
    });
    expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    await page.screenshot({ path: shots('1-no-key') });

    // 设置页存假 key
    await page.getByTestId('no-key-notice').getByRole('link', { name: '去设置' }).click();
    await expect(page.getByTestId('key-status')).toHaveText(/未配置/);
    await page.getByLabel('DeepSeek API key').fill(FAKE_KEY);
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('settings-message')).toHaveText('已保存。');
    await expect(page.getByTestId('key-status')).toHaveText(/已配置/);
    await expect(page.getByTestId('no-key-notice')).toHaveCount(0);
    await expect(page.getByLabel('DeepSeek API key')).toHaveValue('');
    await page.screenshot({ path: shots('2-key-saved') });

    // 页面拿不到 key:桥的返回值、DOM、存储、cookie、/api/status 响应里都没有;也看不到 Host 的 session cookie
    const dump = await page.evaluate(async () => {
      const api = (window as unknown as { vidroom: { getKeyStatus(): Promise<unknown> } }).vidroom;
      return [
        JSON.stringify(await api.getKeyStatus()),
        document.documentElement.outerHTML,
        JSON.stringify({ ...localStorage }),
        JSON.stringify({ ...sessionStorage }),
        document.cookie,
        await (await fetch('/api/status')).text(),
      ];
    });
    expect(dump[0]).toBe('{"configured":true}');
    expect(dump.join('\n')).not.toContain(FAKE_KEY);
    expect(dump.join('\n')).not.toContain('vidroom_session');

    await closeWindow(first.app);
    await first.exited;
    await expect.poll(() => isAlive(hostPid1), { timeout: 15_000 }).toBe(false);

    // key 文件:存在,里面查不到明文(按 UTF-8、UTF-16LE、Base64 三种写法找)
    expect(existsSync(keyFile)).toBe(true);
    const enc = readFileSync(keyFile);
    const needles = [
      Buffer.from(FAKE_KEY, 'utf8'),
      Buffer.from(FAKE_KEY, 'utf16le'),
      Buffer.from(Buffer.from(FAKE_KEY).toString('base64')),
      Buffer.from('fake-deepseek'),
    ];
    for (const needle of needles) expect(enc.includes(needle)).toBe(false);
    console.log(`[key file] ${enc.length} 字节,前 3 字节 ${JSON.stringify(enc.subarray(0, 3).toString('latin1'))}`);

    // ---------- 第二次启动:key 从加密文件读回,经 IPC 交给 Host ----------
    const second = await launch(userDataDir, fake);
    const hostPid2 = await second.hostPid();
    const page2 = second.page;
    const box = page2.getByLabel('输入消息');
    await expect(box).toBeEnabled();
    await expect(page2.getByTestId('no-key-notice')).toHaveCount(0);

    // key 不在 Host 进程的命令行(和 Linux 上的环境变量)里
    const info = hostProcessInfo(hostPid2);
    expect(info).toContain('host.mjs'); // 确认真读到了 Host 的命令行,不是空串
    expect(info).not.toContain(FAKE_KEY);

    await box.fill('我这台电脑能跑什么');
    await page2.getByRole('button', { name: '发送' }).click();
    const answer = page2.getByTestId('message-assistant').last().getByTestId('message-content');
    await expect(answer).toContainText(expectedGpuSummaryFragment(), { timeout: 30_000 });
    await expect(page2.getByText('调用了工具:probe_gpu')).toBeVisible();
    console.log(`[answer] ${await answer.textContent()}`);
    await page2.screenshot({ path: shots('3-chat-gpu-tier') });
    // 假 LLM 收到的正是设置页存进去的 key:加密 → 落盘 → 重启解密 → IPC 交给 Host,整条链路通
    expect(fake.authHeaders.length).toBeGreaterThan(0);
    expect(new Set(fake.authHeaders)).toEqual(new Set([`Bearer ${FAKE_KEY}`]));

    // ---------- 有任务在跑时关窗:先问 ----------
    // 原生对话框 Playwright 看不到,在主进程里换掉 dialog.showMessageBox,记下被问了什么、按预设作答
    await second.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __asked: string[]; __answer: number };
      g.__asked = [];
      g.__answer = 1; // 先点「取消」
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const opts = args[args.length - 1] as { message: string };
        g.__asked.push(opts.message);
        return { response: g.__answer, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    const asked = () => second.app.evaluate(() => (globalThis as unknown as { __asked: string[] }).__asked);
    const windowCount = () => second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

    await box.fill('慢一点的任务');
    await page2.getByRole('button', { name: '发送' }).click();
    await expect.poll(() => fake.held(), { timeout: 30_000 }).toBe(1);
    await page2.screenshot({ path: shots('4-task-running') });

    await closeWindow(second.app);
    await expect.poll(asked).toEqual(['还有任务在进行,确定要关闭吗?']);
    expect(await windowCount()).toBe(1); // 点了取消,窗口还在

    await second.app.evaluate(() => {
      (globalThis as unknown as { __answer: number }).__answer = 0; // 这次点「仍然关闭」
    });
    await closeWindow(second.app);
    await second.exited;

    // 退出后 Host 不残留
    await expect.poll(() => isAlive(hostPid2), { timeout: 15_000 }).toBe(false);
    console.log(`[host] 两次启动的 Host pid ${hostPid1}、${hostPid2} 在应用退出后都已不在`);
  } finally {
    fake.release();
    await fake.close();
  }
});

test('没有任务在跑时关窗:不问,直接退出,Host 不残留', async () => {
  const fake = await startFakeLlm();
  try {
    const run = await launch(mkdtempSync(join(tmpdir(), 'vidroom-desktop-e2e-')), fake);
    const hostPid = await run.hostPid();
    await expect(run.page.getByTestId('preset-workflows')).toBeVisible();
    await run.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => {
        throw new Error('不该弹询问');
      }) as typeof dialog.showMessageBox;
    });
    await closeWindow(run.app);
    await run.exited;
    await expect.poll(() => isAlive(hostPid), { timeout: 15_000 }).toBe(false);
  } finally {
    await fake.close();
  }
});
