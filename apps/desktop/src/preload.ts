import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type KeyStatus, type OpenComfyResult, type SetKeyResult } from './ipc-channels.js';

// 沙箱里的 preload:只暴露这五个函数,不暴露 ipcRenderer 本身
contextBridge.exposeInMainWorld('vidroom', {
  getKeyStatus: (): Promise<KeyStatus> => ipcRenderer.invoke(IPC.keyStatus),
  setKey: (key: string, provider: string): Promise<SetKeyResult> => ipcRenderer.invoke(IPC.setKey, key, provider),
  setProvider: (provider: string): Promise<SetKeyResult> => ipcRenderer.invoke(IPC.setProvider, provider),
  openComfyUI: (): Promise<OpenComfyResult> => ipcRenderer.invoke(IPC.openComfyUI),
  openAbuseReport: (): Promise<void> => ipcRenderer.invoke(IPC.openAbuseReport),
});
