import { join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { handleAppRequest } from './app-protocol.js';
import { comfyUrlFromStatus } from './comfy-url.js';
import { HostProcess } from './host-process.js';
import { KeyStore, normalizeKeyInput } from './key-store.js';
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

// 打包版 Host 被打成单文件、没有 node_modules:解压 ComfyUI 便携包用的 7za.exe 随安装包放在 resources/bin
const hostEnv: Record<string, string> =
  resourcesDir && process.platform === 'win32' ? { VIDROOM_7ZA: join(resourcesDir, 'bin', '7za.exe') } : {};
const host = new HostProcess({ script: hostScript, webDir, env: hostEnv, log });
let keyStore: KeyStore;

/** 粗略的「有任务在跑」:正在转发中的聊天请求数(第 3 批有了任务队列再换成真的任务状态) */
let chatsInFlight = 0;

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
  handleTrusted(IPC.keyStatus, (): KeyStatus => ({ configured: keyStore.has() }));

  handleTrusted(IPC.setKey, async (_event, raw): Promise<SetKeyResult> => {
    const key = normalizeKeyInput(raw);
    if (key === null) return { ok: false, message: 'key 格式不对:不能为空,不能含空格或换行。' };
    if (!encryptionUsable()) return { ok: false, message: '本机系统加密存储不可用,不能安全保存 key。' };
    keyStore.save(key);
    await host.setKey(key);
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
    if (allowClose || chatsInFlight === 0) return;
    event.preventDefault();
    if (asking) return;
    asking = true;
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: 'VidRoom',
        message: '还有任务在进行,确定要关闭吗?',
        detail: '关闭后正在进行的任务会中断。',
        buttons: ['仍然关闭', '取消'],
        defaultId: 1,
        cancelId: 1,
      })
      .then(({ response }) => {
        asking = false;
        if (response === 0) {
          allowClose = true;
          win.close();
        }
      });
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

  keyStore = new KeyStore(app.getPath('userData'), {
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data),
  });

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
  await host.start(keyStore.load());
  createWindow();
}).catch((err) => {
  console.error('[vidroom-desktop] 启动失败:', err instanceof Error ? err.message : String(err));
  dialog.showErrorBox('VidRoom 启动失败', err instanceof Error ? err.message : String(err));
  app.exit(1);
});
