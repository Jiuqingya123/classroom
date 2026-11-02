import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DesktopApi } from '../shared/ipc';

/**
 * preload 只做一件事：把「桌面端才有」的能力开一个最小口子。
 * 不暴露 ipcRenderer 本身、不暴露 fs/path —— 渲染进程拿不到任意 IPC 通道。
 *
 * 注意：sandbox 模式下 preload 只能 require('electron')，没有 Buffer / events / timers。
 */
const api: DesktopApi = {
  platform: process.platform,
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getRefreshToken: () => ipcRenderer.invoke(IPC.getRefreshToken),
  setRefreshToken: (token: string | null) => ipcRenderer.invoke(IPC.setRefreshToken, token),
  requestMediaAccess: (kind) => ipcRenderer.invoke(IPC.requestMediaAccess, kind),
  screenAccessStatus: () => ipcRenderer.invoke(IPC.screenAccessStatus),
  openScreenSettings: () => ipcRenderer.invoke(IPC.openScreenSettings),
  openMediaSettings: (kind) => ipcRenderer.invoke(IPC.openMediaSettings, kind),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  listScreenSources: () => ipcRenderer.invoke(IPC.listScreenSources),
  pickScreenSource: (id: string) => ipcRenderer.invoke(IPC.pickScreenSource, id),
};

contextBridge.exposeInMainWorld('desktop', api);
