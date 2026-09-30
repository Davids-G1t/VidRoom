import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type KeyStatus, type SetKeyResult } from './ipc-channels.js';

// 沙箱里的 preload:只暴露两个函数,不暴露 ipcRenderer 本身
contextBridge.exposeInMainWorld('vidroom', {
  getKeyStatus: (): Promise<KeyStatus> => ipcRenderer.invoke(IPC.keyStatus),
  setKey: (key: string): Promise<SetKeyResult> => ipcRenderer.invoke(IPC.setKey, key),
});
