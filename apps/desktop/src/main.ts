import { join } from 'node:path';
import { BrowserWindow, Menu, app, dialog, ipcMain, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { ABUSE_REPORT_URL } from '../../web/src/api.js';
import { handleAppRequest } from './app-protocol.js';
import { comfyUrlFromStatus } from './comfy-url.js';
import { HostProcess } from './host-process.js';
import { LLM_PROVIDERS, isLlmProvider, type LlmProvider } from '../../host/src/llm-provider.js';
import { KeyStore, loadProvider, normalizeKeyInput, saveProvider } from './key-store.js';
import { IPC, type KeyStatus, type OpenComfyResult, type SetKeyResult } from './ipc-channels.js';
import { APP_ENTRY_URL, APP_SCHEME, assertTrustedSender, isAppUrl } from './trust.js';

// 只给自动化测试隔离用户数据目录用(Electron 自己没有对应的命令行参数)
if (process.env.VIDROOM_USER_DATA_DIR) app.setPath('userData', process.env.VIDROOM_USER_DATA_DIR);

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const log = (msg: string) => console.log(msg);

/** 打包后资源在 resources/ 下;开发时在仓库里 */
const resourcesDir = app.isPackaged ? process.resourcesPath : null;
const hostScript = resourcesDir ? join(resourcesDir, 'host', 'host.mjs') : join(app.getAppPath(), 'dist', 'host', 'host.mjs');
const webDir = resourcesDir ? join(resourcesDir, 'web') : join(app.getAppPath(), '..', 'web', 'dist');

// 打包版 Host 被打成单文件、没有 node_modules:解压 ComfyUI 便携包用的 7za.exe 随安装包放在 resources/bin;
// 代码渲染用的 HyperFrames CLI(连同它的 node_modules)放在 resources/hyperframes
const hostEnv: Record<string, string> = resourcesDir
  ? {
      VIDROOM_HYPERFRAMES_DIR: join(resourcesDir, 'hyperframes'),
      ...(process.platform === 'win32' ? { VIDROOM_7ZA: join(resourcesDir, 'bin', '7za.exe') } : {}),
    }
  : {};
const host = new HostProcess({ script: hostScript, webDir, env: hostEnv, log });
let keyStores: Record<LlmProvider, KeyStore>;
let userDataDir: string;

/** 正在转发中的聊天请求数(出片在 generate_video 工具里跑,也算在聊天请求里) */
let chatsInFlight = 0;

/** 有没有任务在跑:聊天请求挂着,或 Host 报告正在出片 */
async function taskRunning(): Promise<boolean> {
  if (chatsInFlight > 0) return true;
  try {
    const res = await host.fetchApi('/api/video/job', { method: 'GET' });
    const job = res.ok ? ((await res.json()) as { state?: string }) : null;
    return job?.state === 'preparing' || job?.state === 'running';
  } catch {
    return false;
  }
}

function openAbuseReport(): Promise<void> {
  log(`[vidroom-desktop] 打开举报滥用页 ${ABUSE_REPORT_URL}`);
  return shell.openExternal(ABUSE_REPORT_URL);
}

/** 所有 IPC handler 都经这里注册:先核来源,不可信就拒绝并记日志 */
function handleTrusted<T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event, channel);
    return handler(event, ...args);
  });
}

function encryptionUsable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  // Linux 没有系统钥匙串时会退回写死口令的 basic_text,等于没加密:不用
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

function registerIpc(): void {
  handleTrusted(IPC.keyStatus, (): KeyStatus => {
    const provider = loadProvider(userDataDir);
    const providers = Object.fromEntries(LLM_PROVIDERS.map((p) => [p, keyStores[p].has()])) as Record<LlmProvider, boolean>;
    return { configured: providers[provider], provider, providers };
  });

  // 存某家的 key,并切换成用这家
  handleTrusted(IPC.setKey, async (_event, raw, rawProvider): Promise<SetKeyResult> => {
    if (!isLlmProvider(rawProvider)) return { ok: false, message: '不认识的 LLM 提供方。' };
    const key = normalizeKeyInput(raw);
    if (key === null) return { ok: false, message: 'key 格式不对:不能为空,不能含空格或换行。' };
    if (!encryptionUsable()) return { ok: false, message: '本机系统加密存储不可用,不能安全保存 key。' };
    keyStores[rawProvider].save(key);
    saveProvider(userDataDir, rawProvider);
    await host.setKey(rawProvider, key);
    return { ok: true };
  });

  // 切换用哪家:这家有 key 就交给 Host,没有就当没配置
  handleTrusted(IPC.setProvider, async (_event, rawProvider): Promise<SetKeyResult> => {
    if (!isLlmProvider(rawProvider)) return { ok: false, message: '不认识的 LLM 提供方。' };
    saveProvider(userDataDir, rawProvider);
    await host.setKey(rawProvider, keyStores[rawProvider].load());
    return { ok: true };
  });

  handleTrusted(IPC.openComfyUI, async (): Promise<OpenComfyResult> => {
    const res = await host.fetchApi('/api/comfyui', { method: 'GET' });
    const url = comfyUrlFromStatus(res.ok ? await res.json() : null);
    if (url === null) return { ok: false, message: 'ComfyUI 还没有运行。' };
    await shell.openExternal(url);
    log(`[vidroom-desktop] 在系统浏览器里打开 ${url}`);
    return { ok: true, url };
  });

  handleTrusted(IPC.openAbuseReport, () => openAbuseReport());
}

/** 应用菜单:「帮助 → 举报滥用」打开 GitHub 上的举报 issue 模板 */
function setupMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      { label: '帮助', submenu: [{ id: 'abuse-report', label: '举报滥用', click: () => void openAbuseReport() }] },
    ]),
  );
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    title: 'VidRoom',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win.show());

  let allowClose = false;
  let asking = false;
  win.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (asking) return;
    asking = true;
    void (async () => {
      try {
        if (await taskRunning()) {
          const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            title: 'VidRoom',
            message: '还有任务在进行,确定要关闭吗?',
            detail: '关闭后正在进行的任务会中断,正在生成的视频不会保存。',
            buttons: ['仍然关闭', '取消'],
            defaultId: 1,
            cancelId: 1,
          });
          if (response !== 0) return;
          // 确认关闭:先让 Host 打断出片任务并停掉 ComfyUI,再关窗
          await host.fetchApi('/api/video/cancel', { method: 'POST' }).catch(() => {});
        }
        allowClose = true;
        win.close();
      } finally {
        asking = false;
      }
    })();
  });

  void win.loadURL(APP_ENTRY_URL);
  return win;
}

app.on('web-contents-created', (_event, contents) => {
  // 页面不许跳出本协议、不许开新窗口、不许嵌 webview
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      log(`[vidroom-desktop] 拦下导航:${url}`);
    }
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('window-all-closed', () => app.quit());
// 退出时连带杀掉 Host;Host 自己也在父进程断开时退出,双保险
app.on('will-quit', () => host.kill());
process.on('exit', () => host.kill());

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  userDataDir = app.getPath('userData');
  const cipher = {
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (data: Buffer) => safeStorage.decryptString(data),
  };
  keyStores = Object.fromEntries(LLM_PROVIDERS.map((p) => [p, new KeyStore(userDataDir, cipher, log, p)])) as Record<LlmProvider, KeyStore>;

  protocol.handle(APP_SCHEME, (request) =>
    handleAppRequest(request, {
      webDir,
      forwardApi: async (path, init) => {
        const isChat = path.startsWith('/api/chat') && init.method === 'POST';
        if (isChat) chatsInFlight += 1;
        try {
          return await host.fetchApi(path, init);
        } finally {
          if (isChat) chatsInFlight -= 1;
        }
      },
    }),
  );

  registerIpc();
  setupMenu();
  const provider = loadProvider(userDataDir);
  await host.start(provider, keyStores[provider].load());
  createWindow();
}).catch((err) => {
  console.error('[vidroom-desktop] 启动失败:', err instanceof Error ? err.message : String(err));
  dialog.showErrorBox('VidRoom 启动失败', err instanceof Error ? err.message : String(err));
  app.exit(1);
});
