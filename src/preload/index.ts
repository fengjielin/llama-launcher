/**
 * preload：唯一允许跨越主进程/渲染层边界的地方。
 *
 * 只暴露 `LlamaApi` 里列明的方法，不开 nodeIntegration、不给渲染层任何 IPC 通道名，
 * 于是界面能做的事被严格限制在"读配置、改配置、启停、看日志"之内。
 */

import { contextBridge, ipcRenderer } from "electron";
import type { LauncherConfig } from "../core/types.ts";
import { IPC } from "../shared/ipc.ts";
import type { LlamaApi, LogPush, PickPathRequest, StatePush } from "../shared/ipc.ts";

const api: LlamaApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  openConfig: () => ipcRenderer.invoke(IPC.configOpen),
  saveConfig: (config: LauncherConfig) => ipcRenderer.invoke(IPC.configSave, config),
  saveConfigAs: (config: LauncherConfig) => ipcRenderer.invoke(IPC.configSaveAs, config),
  migrateConfig: () => ipcRenderer.invoke(IPC.configMigrate),
  pickPath: (request: PickPathRequest) => ipcRenderer.invoke(IPC.pickPath, request),
  detect: () => ipcRenderer.invoke(IPC.detect),
  preview: (config: LauncherConfig) => ipcRenderer.invoke(IPC.preview, config),
  start: (config: LauncherConfig) => ipcRenderer.invoke(IPC.start, config),
  stop: () => ipcRenderer.invoke(IPC.stop),
  status: () => ipcRenderer.invoke(IPC.status),
  health: () => ipcRenderer.invoke(IPC.health),
  openWebUi: () => ipcRenderer.invoke(IPC.openWebUi),
  revealPath: (path: string) => ipcRenderer.invoke(IPC.revealPath, path),
  recentLogs: () => ipcRenderer.invoke(IPC.logsRecent),

  onLog(handler: (entry: LogPush) => void) {
    const listener = (_event: unknown, entry: LogPush): void => handler(entry);
    ipcRenderer.on(IPC.pushLog, listener);
    return () => {
      ipcRenderer.removeListener(IPC.pushLog, listener);
    };
  },

  onState(handler: (state: StatePush) => void) {
    const listener = (_event: unknown, state: StatePush): void => handler(state);
    ipcRenderer.on(IPC.pushState, listener);
    return () => {
      ipcRenderer.removeListener(IPC.pushState, listener);
    };
  },
};

contextBridge.exposeInMainWorld("llamaApi", api);
