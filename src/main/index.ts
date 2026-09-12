/**
 * Electron 主进程：只做三件事 —— 开窗口、注册 IPC、把会话事件推给界面。
 * 业务逻辑全在 LauncherSession（不 import electron，可单测）。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  FileFilter,
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from "electron";
import type { LauncherConfig } from "../core/types.ts";
import { IPC } from "../shared/ipc.ts";
import type { ConfigFileResult, PickKind, PickPathRequest, PickPathResult } from "../shared/ipc.ts";
import { LauncherSession } from "./session.ts";

const preloadPath = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
const rendererHtml = fileURLToPath(new URL("../renderer/index.html", import.meta.url));

let win: BrowserWindow | null = null;
let session: LauncherSession | null = null;
let quitting = false;

/** 配置默认放项目根目录（开发时一目了然）；打包后放用户数据目录（安装目录只读） */
function defaultConfigPath(): string {
  return app.isPackaged
    ? join(app.getPath("userData"), "llama-launcher.json")
    : join(app.getAppPath(), "llama-launcher.json");
}

function getSession(): LauncherSession {
  if (session === null) {
    session = new LauncherSession(defaultConfigPath(), {
      onLog: (entry) => win?.webContents.send(IPC.pushLog, entry),
      onState: (push) => win?.webContents.send(IPC.pushState, push),
    });
  }
  return session;
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0b0e14",
    title: "llama.cpp 启动器",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => {
    win = null;
  });

  // ⚠ 监听必须挂在 load 之前：await loadFile() 是在 did-finish-load 之后才 resolve 的，
  //   挂晚了就永远等不到事件（实测会一直不退出）。
  installUiExport(win);

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl !== undefined && devUrl !== "") {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(rendererHtml);
  }
}

/**
 * 无人值守的界面自检入口（默认关闭，只有设了环境变量才生效）：
 *   set LLAMA_LAUNCHER_UI_DUMP=E:\path\ui            # 会写出 ui.txt 和 ui.png
 *   electron .
 *
 * 为什么需要它：界面到底渲染出了什么，光看源码不算数 —— React 有没有挂载、IPC 有没有通、
 * 配置有没有读到、命令行有没有拼出来、哪些参数被置灰，导出文本加截图一眼就能核对，
 * 而且不需要人守在屏幕前。截的是渲染内容本身（capturePage），不受窗口是否被遮挡影响。
 */
function installUiExport(target: BrowserWindow): void {
  const base = process.env["LLAMA_LAUNCHER_UI_DUMP"];
  if (base === undefined || base === "") return;

  target.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void (async () => {
        const textPath = `${base}.txt`;
        try {
          // 可选：先在渲染层里执行一段 JS（例如点一下"启动服务"），再等一会儿截图，
          // 这样能连"界面操作 → IPC → 进程 → 日志推回界面"整条链路一起验证。
          const script = process.env["LLAMA_LAUNCHER_UI_EXEC"];
          if (script !== undefined && script !== "") {
            await target.webContents.executeJavaScript(script);
            await new Promise((resolve) => setTimeout(resolve, Number(process.env["LLAMA_LAUNCHER_UI_EXEC_WAIT"] ?? 9000)));
          }

          const text: unknown = await target.webContents.executeJavaScript("document.body.innerText");
          const structured: unknown = await target.webContents.executeJavaScript(`(() => {
            const tabs = [...document.querySelectorAll("nav button")].map((b) => b.textContent.replace(/\\s+/g, " ").trim());
            const groups = [...document.querySelectorAll("main section > button")].map((b) => b.innerText.replace(/\\s+/g, " ").trim());
            const rows = [...document.querySelectorAll("table tbody tr")].map((tr) => tr.innerText.replace(/\\s+/g, " ").trim());
            const fields = [...document.querySelectorAll("aside input, aside select")].map((el) => el.value ?? "");
            const badges = [...document.querySelectorAll("span")].map((s) => s.textContent.trim()).filter((t) => t.length > 0 && t.length < 12);
            const logLines = [...document.querySelectorAll("main .mono div")].map((d) => d.innerText.replace(/\\s+/g, " ").trim()).slice(0, 60);
            return JSON.stringify({ tabs, paramGroups: groups, decisionRows: rows, sideFields: fields, badges: [...new Set(badges)], logLines }, null, 2);
          })()`);
          writeFileSync(textPath, `=== 界面渲染文本 ===\n${String(text)}\n\n=== 结构化摘要 ===\n${String(structured)}\n`, "utf8");
          const image = await target.webContents.capturePage();
          writeFileSync(`${base}.png`, image.toPNG());
        } catch (err) {
          writeFileSync(textPath, `导出失败：${err instanceof Error ? err.message : String(err)}\n`, "utf8");
        } finally {
          app.quit();
        }
      })();
    }, 3500);
  });
}

const DIALOG_FILTERS: Record<PickKind, FileFilter[]> = {
  gguf: [{ name: "GGUF 模型", extensions: ["gguf"] }],
  ini: [{ name: "presets.ini", extensions: ["ini"] }],
  json: [{ name: "JSON 配置", extensions: ["json"] }],
  directory: [],
};

/** 有窗口时以它为父窗口（对话框居中且模态），没有就退化成无父窗口调用 */
async function showOpen(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const parent = win;
  return parent === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(parent, options);
}

async function showSave(options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  const parent = win;
  return parent === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(parent, options);
}

function registerIpc(): void {
  const s = (): LauncherSession => getSession();

  ipcMain.handle(IPC.bootstrap, () => s().bootstrap());
  ipcMain.handle(IPC.detect, () => s().detect());
  ipcMain.handle(IPC.preview, (_e, config: LauncherConfig) => s().preview(config));
  ipcMain.handle(IPC.start, (_e, config: LauncherConfig) => s().start(config));
  ipcMain.handle(IPC.stop, () => s().stop());
  ipcMain.handle(IPC.status, () => s().status());
  ipcMain.handle(IPC.health, () => s().health());
  ipcMain.handle(IPC.logsRecent, () => s().recentLogs());

  ipcMain.handle(IPC.configSave, (_e, config: LauncherConfig) => s().saveConfig(config));
  ipcMain.handle(IPC.configSaveAs, async (_e, config: LauncherConfig) => {
    const target = await showSave({
      title: "另存配置",
      defaultPath: s().getConfigPath(),
      filters: [{ name: "JSON 配置", extensions: ["json"] }],
    });
    if (target.canceled || target.filePath === undefined) return { canceled: true, path: null };
    s().saveConfig(config, target.filePath);
    return { canceled: false, path: target.filePath };
  });

  ipcMain.handle(IPC.configOpen, async (): Promise<ConfigFileResult> => {
    const picked = await showOpen({
      title: "打开配置",
      defaultPath: s().getConfigPath(),
      filters: [{ name: "JSON 配置", extensions: ["json"] }],
      properties: ["openFile"],
    });
    const path = picked.filePaths[0];
    if (picked.canceled || path === undefined) return { canceled: true, path: null, payload: null, warnings: [] };
    const payload = s().openConfig(path);
    return { canceled: false, path, payload, warnings: payload.warnings };
  });

  ipcMain.handle(IPC.configMigrate, async (): Promise<ConfigFileResult> => {
    const picked = await showOpen({
      title: "选择原版启动器 v1.9 的 llama_launcher_config.json",
      filters: [{ name: "JSON 配置", extensions: ["json"] }],
      properties: ["openFile"],
    });
    const path = picked.filePaths[0];
    if (picked.canceled || path === undefined) return { canceled: true, path: null, payload: null, warnings: [] };
    try {
      const payload = s().migrateFrom(path);
      return { canceled: false, path: payload.configPath, payload, warnings: payload.warnings };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const payload = s().bootstrap();
      return { canceled: false, path: null, payload, warnings: [`迁移失败：${message}`] };
    }
  });

  ipcMain.handle(IPC.pickPath, async (_e, request: PickPathRequest): Promise<PickPathResult> => {
    const filters = DIALOG_FILTERS[request.kind] ?? [];
    const picked = await showOpen({
      title: request.title ?? "选择路径",
      defaultPath: request.defaultPath === undefined || request.defaultPath === "" ? undefined : request.defaultPath,
      filters,
      properties: request.kind === "directory" ? ["openDirectory"] : ["openFile"],
    });
    const path = picked.filePaths[0];
    if (picked.canceled || path === undefined) return { canceled: true, path: null };
    return { canceled: false, path };
  });

  ipcMain.handle(IPC.openWebUi, async () => {
    const status = await s().status();
    await shell.openExternal(status.baseUrl);
    return { ok: true, url: status.baseUrl };
  });

  ipcMain.handle(IPC.revealPath, (_e, path: string) => {
    if (typeof path === "string" && path !== "") shell.showItemInFolder(path);
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * 退出前先把 llama-server 停掉。
 * 不这么做的话，关掉界面会留下一个占着显存的孤儿进程 —— 下次启动就"显存莫名被占满"。
 * 所以这里拦一次退出，等 stop() 完成（内含 taskkill /T /F 兜底）再真正退出。
 */
app.on("before-quit", (event) => {
  if (quitting || session === null) return;
  event.preventDefault();
  quitting = true;
  void session
    .stop()
    .catch(() => undefined)
    .finally(() => app.quit());
});
