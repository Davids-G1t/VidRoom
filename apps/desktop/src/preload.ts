import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type CloudKeysStatus, type KeyStatus, type OpenComfyResult, type SetKeyResult } from './ipc-channels.js';

// 沙箱里的 preload:只暴露这几个函数,不暴露 ipcRenderer 本身
contextBridge.exposeInMainWorld('vidroom', {
  getKeyStatus: (): Promise<KeyStatus> => ipcRenderer.invoke(IPC.keyStatus),
  setKey: (key: string, provider: string): Promise<SetKeyResult> => ipcRenderer.invoke(IPC.setKey, key, provider),
  setProvider: (provider: string): Promise<SetKeyResult> => ipcRenderer.invoke(IPC.setProvider, provider),
  getCloudKeyStatus: (): Promise<CloudKeysStatus> => ipcRenderer.invoke(IPC.cloudKeyStatus),
  setCloudKey: (key: string, kind: string): Promise<SetKeyResult> => ipcRenderer.invoke(IPC.setCloudKey, key, kind),
  openComfyUI: (): Promise<OpenComfyResult> => ipcRenderer.invoke(IPC.openComfyUI),
  openAbuseReport: (): Promise<void> => ipcRenderer.invoke(IPC.openAbuseReport),
});
