/**
 * preload：唯一允许跨越主进程/渲染层边界的地方。
 *
 * 只暴露 `LlamaApi` 里列明的方法，不开 nodeIntegration、不给渲染层任何 IPC 通道名，
 * 于是界面能做的事被严格限制在"读配置、改配置、启停、看日志"之内。
 */

import { contextBridge, ipcRenderer } from "electron";
import type { LauncherConfig } from "../core/types.ts";
import { IPC } from "../shared/ipc.ts";
import type {
  AppSettings,
  LlamaApi,
  LogPush,
  MetricsPayload,
  PickPathRequest,
  StatePush,
} from "../shared/ipc.ts";

const api: LlamaApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  openConfig: () => ipcRenderer.invoke(IPC.configOpen),
  saveConfig: (config: LauncherConfig) => ipcRenderer.invoke(IPC.configSave, config),
  saveConfigAs: (config: LauncherConfig) => ipcRenderer.invoke(IPC.configSaveAs, config),
  migrateConfig: () => ipcRenderer.invoke(IPC.configMigrate),
  pickPath: (request: PickPathRequest) => ipcRenderer.invoke(IPC.pickPath, request),
  detect: () => ipcRenderer.invoke(IPC.detect),
  precheck: (force?: boolean) => ipcRenderer.invoke(IPC.precheck, force === true),
  preview: (config: LauncherConfig) => ipcRenderer.invoke(IPC.preview, config),
  start: (config: LauncherConfig) => ipcRenderer.invoke(IPC.start, config),
  stop: () => ipcRenderer.invoke(IPC.stop),
  status: () => ipcRenderer.invoke(IPC.status),
  health: () => ipcRenderer.invoke(IPC.health),
  openWebUi: () => ipcRenderer.invoke(IPC.openWebUi),
  revealPath: (path: string) => ipcRenderer.invoke(IPC.revealPath, path),
  recentLogs: () => ipcRenderer.invoke(IPC.logsRecent),

  // ---- 指标监控（M3）----
  metricsSnapshot: () => ipcRenderer.invoke(IPC.metricsSnapshot),
  metricsWatch: (active: boolean) => ipcRenderer.invoke(IPC.metricsWatch, active),
  onMetrics(handler: (payload: MetricsPayload) => void) {
    const listener = (_event: unknown, payload: MetricsPayload): void => handler(payload);
    ipcRenderer.on(IPC.pushMetrics, listener);
    return () => {
      ipcRenderer.removeListener(IPC.pushMetrics, listener);
    };
  },

  // ---- 配置档案（M3）----
  listProfiles: () => ipcRenderer.invoke(IPC.profilesList),
  saveProfile: (name: string, config: LauncherConfig) => ipcRenderer.invoke(IPC.profilesSave, name, config),
  loadProfile: (name: string) => ipcRenderer.invoke(IPC.profilesLoad, name),
  deleteProfile: (name: string) => ipcRenderer.invoke(IPC.profilesDelete, name),
  revealProfiles: () => ipcRenderer.invoke(IPC.profilesReveal),

  // ---- 应用设置（M3）----
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsSet, patch),

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
