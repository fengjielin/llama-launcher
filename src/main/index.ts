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

/**
 * 默认配置文件的路径。
 *
 * 开发时放在项目根目录（和应用代码在一起，改起来一目了然）；
 * 打包后必须放用户数据目录，因为安装目录是只读的，写配置文件会失败。
 *
 * @returns 配置文件的绝对路径
 */
function defaultConfigPath(): string {
  return app.isPackaged
    ? join(app.getPath("userData"), "llama-launcher.json")
    : join(app.getAppPath(), "llama-launcher.json");
}

/**
 * 取会话单例（懒加载）。
 *
 * 之所以懒加载：创建会话时会读配置文件、探测 llama-server，属于"用到了才付这个成本"；
 * 同时这里把日志与状态回调接到窗口上 —— 会话本身不认识 electron，
 * 事件由这一层转发给渲染层。
 *
 * 注意 `win?.` 的空值保护：窗口可能已关闭（正常退出流程），此时事件直接丢掉即可。
 *
 * @returns 全局唯一的 {@link LauncherSession}
 */
function getSession(): LauncherSession {
  if (session === null) {
    session = new LauncherSession(defaultConfigPath(), {
      onLog: (entry) => win?.webContents.send(IPC.pushLog, entry),
      onState: (push) => win?.webContents.send(IPC.pushState, push),
    });
  }
  return session;
}

/**
 * 创建主窗口并加载界面。
 *
 * 几个关键设置：
 * - `show: false` + `ready-to-show` 再显示：避免先出现白屏再闪出内容
 * - `contextIsolation: true` + `nodeIntegration: false`：渲染层拿不到 Node 能力，
 *   只能通过 preload 暴露的窄 API 办事
 * - `sandbox: false`：preload 是 ESM/CJS 混合产物，需要关掉沙箱渲染进程才能加载
 *   （安全性由 contextIsolation + 窄 API 保证，不靠沙箱）
 * - 开发模式走 `ELECTRON_RENDERER_URL`（Vite dev server，有 HMR），
 *   否则加载构建产物 `out/renderer/index.html`
 *
 * @returns 窗口创建并加载完成时 resolve
 */
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
      // ESM/CJS 混合的 preload 需要非沙箱渲染进程；安全性靠 contextIsolation + 窄 API 保证
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
 *
 * 执行顺序：等 3.5s（首次渲染 + 自动探测都要时间）→ 可选执行一段 JS → 导出文本与截图
 * → **无论成败都退出应用**（`finally` 里 `app.quit()`），保证无人值守时不会挂住。
 *
 * @param target 要自检的窗口；未设置 `LLAMA_LAUNCHER_UI_DUMP` 时本函数直接返回，不产生任何副作用
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

/** 各类路径选择对话框的文件过滤器；`directory` 走 openDirectory，不需要过滤器 */
const DIALOG_FILTERS: Record<PickKind, FileFilter[]> = {
  gguf: [{ name: "GGUF 模型", extensions: ["gguf"] }],
  ini: [{ name: "presets.ini", extensions: ["ini"] }],
  json: [{ name: "JSON 配置", extensions: ["json"] }],
  directory: [],
};

/**
 * 打开文件/目录选择框。
 *
 * 封装的原因：Electron 的重载要求"有父窗口"和"无父窗口"两种签名分开调用，
 * 直接写 `showOpenDialog(win ?? undefined, ...)` 类型上过不去，运行期也会出问题。
 *
 * @param options 对话框选项（标题、过滤器、是否选目录等）
 * @returns 选择结果；用户取消时 `canceled` 为 `true`
 */
async function showOpen(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const parent = win;
  return parent === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(parent, options);
}

/**
 * 打开另存为对话框，理由同 {@link showOpen}。
 *
 * @param options 对话框选项（标题、默认路径、过滤器）
 * @returns 选择结果；用户取消时 `canceled` 为 `true`
 */
async function showSave(options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  const parent = win;
  return parent === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(parent, options);
}

/**
 * 注册全部 IPC 通道。
 *
 * 约定：**每个 handler 只做两件事** —— 必要时弹对话框、然后把活交给 `LauncherSession`。
 * 业务逻辑一律不写在这里（那样就没法脱离 electron 做单测了）。
 * 通道名统一取自 `IPC` 常量，避免两侧手写字符串写错。
 *
 * 错误处理策略：能展示给用户的失败（找不到 exe、拼装失败、迁移的文件不是合法 JSON）
 * 都以返回值表达；只有真正意外的异常才让它冒泡成 IPC 拒绝。
 */
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
  // 另存为：取消就原样返回，不写盘；保存成功后把界面上的配置路径同步成新路径
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
      // 迁移失败（选错了文件、JSON 坏了）不该让界面崩掉：
      // 退回当前状态并只把原因放进 warnings 展示
      const message = err instanceof Error ? err.message : String(err);
      const payload = s().bootstrap();
      return { canceled: false, path: null, payload, warnings: [`迁移失败：${message}`] };
    }
  });

  // 通用路径选择：模型/目录/presets.ini 都由界面发起，这里按 kind 决定选文件还是选目录
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

  // 用系统默认浏览器打开 llama-server 自带的 WebUI；
  // 地址取会话推导出的 baseUrl（端口可能因顺延而与配置不同）
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

// macOS 上关掉所有窗口不等于退出应用，点 Dock 图标要能重新开窗
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
