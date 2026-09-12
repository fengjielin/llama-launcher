/**
 * Electron 主进程：只做三件事 —— 开窗口、注册 IPC、把会话事件推给界面。
 * 业务逻辑全在 LauncherSession（不 import electron，可单测）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import type {
  AppSettings,
  AppSettingsPayload,
  ConfigFileResult,
  MetricsPayload,
  PickKind,
  PickPathRequest,
  PickPathResult,
  ProfileLoadResult,
  ProfilesPayload,
} from "../shared/ipc.ts";
import { LauncherSession } from "./session.ts";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, settingsPathFor } from "./settings.ts";
import { chooseDataLayout } from "./paths.ts";
import { TrayController } from "./tray.ts";
import type { TrayState } from "./tray.ts";

const preloadPath = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
const rendererHtml = fileURLToPath(new URL("../renderer/index.html", import.meta.url));

let win: BrowserWindow | null = null;
let session: LauncherSession | null = null;
let tray: TrayController | null = null;
let quitting = false;

/** 应用级设置（开机自启 / 关闭窗口行为）。落盘路径在 app ready 之后才能拿到，故先留空 */
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let settingsPath = "";

/** 开机自启目前只实现了 Windows 与 macOS（Linux 需要装 .desktop 项，见 README 的 M3 说明） */
const AUTOSTART_SUPPORTED = process.platform === "win32" || process.platform === "darwin";

/** 由开机自启拉起时带 `--hidden`：只驻留托盘，不弹窗口 */
const START_HIDDEN = process.argv.includes("--hidden");

/**
 * 数据与配置的落点，在模块加载时就算好。
 *
 * 必须**早于 app ready** 调用 `app.setPath("userData", ...)`：Electron 会在 ready 之后
 * 立刻开始使用这个目录（Chromium 的缓存、Local Storage 等），晚了就改不动了。
 *
 * 注意 `defaultUserDataDir` 传的是**函数**：`app.getPath("userData")` 一调用就会把
 * `%APPDATA%\<应用名>` 建出来（实测），而便携模式下我们不需要那个目录 ——
 * 惰性求值才能让它彻底不出现。
 */
const layout = chooseDataLayout({
  isPackaged: app.isPackaged,
  exeDir: dirname(app.getPath("exe")),
  projectDir: app.getAppPath(),
  defaultUserDataDir: () => app.getPath("userData"),
});
if (layout.portable) {
  // 便携模式：把 Chromium 的运行时数据也挪到 exe 旁边，
  // 这样整个文件夹拷走 = 配置与数据一起带走，不会在用户的 AppData 里留下任何东西
  app.setPath("userData", layout.dataDir);
}

/**
 * 配置文件的路径。
 *
 * 开发时在项目根目录（改起来一目了然）；打包后默认**就在 exe 同目录**
 * （便携版惯例：整个文件夹拷走就能用）；只有 exe 所在目录不可写时
 * （例如 NSIS 装进了 Program Files）才退回 userData。
 * 决策逻辑与理由见 `paths.ts` 的 {@link chooseDataLayout}。
 *
 * @returns 配置文件的绝对路径
 */
function defaultConfigPath(): string {
  return layout.configPath;
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
    session = new LauncherSession(
      defaultConfigPath(),
      {
        onLog: (entry) => win?.webContents.send(IPC.pushLog, entry),
        onState: (push) => {
          win?.webContents.send(IPC.pushState, push);
          // 托盘图标要跟着服务状态变色（灰=没跑 / 绿=在跑）
          updateTray({ serverState: push.state, running: push.state === "running" });
        },
        onMetrics: (sample) => win?.webContents.send(IPC.pushMetrics, sample),
      },
      // exe 目录作为自动探测的第一起点：便携版双击启动时 cwd 不可靠
      // （可能在 exe 目录、也可能在系统目录），以 exe 为锚才找得到
      // 「项目目录下并列着 llama.cpp」这种常见布局
      { searchDirs: [dirname(app.getPath("exe"))] },
    );
  }
  return session;
}

// ---------------------------------------------------------------------------
// 设置 / 托盘（M3）
// ---------------------------------------------------------------------------

/** 打包设置载荷：持久化字段 + 运行时信息（平台是否支持自启、文件位置） */
function settingsPayload(): AppSettingsPayload {
  return {
    ...settings,
    autostartSupported: AUTOSTART_SUPPORTED,
    settingsPath,
    dataDir: layout.dataDir,
    configPath: layout.configPath,
    portable: layout.portable,
  };
}

/**
 * 把设置写进系统登录项。
 *
 * 带 `--hidden` 参数：开机自启时只驻留托盘不弹窗（否则每次开机都糊一脸窗口）。
 * 不支持自启的平台直接跳过（Linux），改由界面上的说明告知。
 */
function applyAutostart(): void {
  if (!AUTOSTART_SUPPORTED) return;
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ["--hidden"] });
}

/**
 * 更新设置：改内存 → 落盘 → 同步开机自启 → 刷新托盘勾选状态。
 *
 * 落盘失败只打日志不抛错：设置存不下来不该让界面操作失败，
 * 但要在控制台留下痕迹（用户报"改了设置重启就没了"时有据可查）。
 *
 * @param patch 要修改的设置项
 * @returns 更新后的完整设置载荷
 */
function applySettings(patch: Partial<AppSettings>): AppSettingsPayload {
  settings = { ...settings, ...patch };
  try {
    saveSettings(settingsPath, settings);
  } catch (err) {
    console.error(`设置保存失败（${settingsPath}）：${err instanceof Error ? err.message : String(err)}`);
  }
  applyAutostart();
  tray?.setSettings(settings);
  return settingsPayload();
}

/**
 * 同步托盘状态（窗口可见性 / 服务状态）。
 *
 * `windowVisible` 每次都重新读 —— 它会随用户点窗口而变化，调用方不必自己跟踪。
 *
 * @param next 要覆盖的服务状态字段
 */
function updateTray(next: Partial<Omit<TrayState, "windowVisible">> = {}): void {
  if (tray === null) return;
  tray.update({ ...next, windowVisible: win?.isVisible() ?? false });
}

/** 显示/隐藏主窗口（托盘单击与菜单都走它）；窗口已被销毁则重建 */
function toggleWindow(): void {
  if (win === null) {
    void createWindow();
    return;
  }
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
  updateTray();
}

/** 托盘菜单「启动服务」：用会话里当前那份配置启动，并把结果同步到托盘 */
async function startFromTray(): Promise<void> {
  const result = await getSession().startCurrent();
  if (!("error" in result)) updateTray({ running: result.report.ready, baseUrl: result.baseUrl });
}

/**
 * 创建托盘图标（应用级单例；重复调用直接返回）。
 *
 * 整体包一层 try/catch：托盘创建失败（图标格式不对、系统托盘被策略禁用等）
 * 不该让整个程序起不来 —— 界面与 CLI 仍然可用，只是少了常驻入口。
 * 失败会打一条明确的错误日志，便于排查。
 */
function createTray(): void {
  if (tray !== null) return;
  try {
    tray = new TrayController(
      {
        onToggleWindow: () => toggleWindow(),
        onStart: () => void startFromTray(),
        onStop: () => {
          void getSession()
            .stop()
            .then(() => updateTray({ running: false }));
        },
        onOpenWebUi: () => {
          void getSession()
            .status()
            .then((status) => shell.openExternal(status.baseUrl));
        },
        onChangeSettings: (patch) => {
          applySettings(patch);
        },
        onQuit: () => app.quit(),
      },
      settings,
      { serverState: "idle", running: false, baseUrl: "", windowVisible: win?.isVisible() ?? false },
      AUTOSTART_SUPPORTED,
    );
  } catch (err) {
    tray = null;
    console.error(`创建托盘失败（界面仍可正常使用）：${err instanceof Error ? err.message : String(err)}`);
  }
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

  // 由开机自启拉起（--hidden）时不弹窗，只驻留托盘；其余情况等渲染好再显示，避免白屏闪一下
  if (!START_HIDDEN) win.once("ready-to-show", () => win?.show());
  win.on("show", () => updateTray());
  win.on("hide", () => updateTray());
  win.on("closed", () => {
    win = null;
    updateTray();
  });
  win.on("close", (event) => {
    // 关闭窗口 ≠ 退出：这是台"服务启动器"，服务该继续跑。
    // 真正退出走托盘菜单的「退出」（会先停服再退）。
    if (settings.minimizeToTray && !quitting) {
      event.preventDefault();
      win?.hide();
    }
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
  ipcMain.handle(IPC.precheck, (_e, force: boolean) => s().precheck(force === true));
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

  // ---- 指标监控（M3）----
  ipcMain.handle(IPC.metricsSnapshot, (): Promise<MetricsPayload> => s().metricsSnapshot());
  // active === true 才开采样：界面离开监控页会主动关掉，避免白烧 nvidia-smi
  ipcMain.handle(IPC.metricsWatch, (_e, active: boolean) => s().watchMetrics(active === true));

  // ---- 配置档案（M3）----
  ipcMain.handle(IPC.profilesList, (): ProfilesPayload => s().listProfiles());
  ipcMain.handle(IPC.profilesSave, (_e, name: string, config: LauncherConfig) => s().saveProfile(name, config));
  ipcMain.handle(IPC.profilesLoad, (_e, name: string): ProfileLoadResult => s().loadProfile(name));
  ipcMain.handle(IPC.profilesDelete, (_e, name: string) => s().deleteProfile(name));
  ipcMain.handle(IPC.profilesReveal, () => {
    const dir = s().profilesDir();
    // 目录还不存在时先建出来，否则资源管理器打开会失败
    mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
    return { ok: true, dir };
  });

  // ---- 应用设置（M3）----
  ipcMain.handle(IPC.settingsGet, (): AppSettingsPayload => settingsPayload());
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>): AppSettingsPayload => applySettings(patch));
}

/**
 * 窗口关闭时若设置了「缩到托盘」，应用会继续在后台跑（服务不断），
 * 所以这里再给它一次机会拦一下退出请求 —— 与 `win.on("close")` 是两道保险。
 */
function shouldKeepRunningInTray(): boolean {
  return settings.minimizeToTray && !quitting;
}

app.whenReady().then(async () => {
  // 设置文件必须放在 userData 下：打包后安装目录是只读的
  settingsPath = settingsPathFor(app.getPath("userData"));
  settings = loadSettings(settingsPath);
  // 与系统登录项对一次账（用户可能在系统设置里改过）
  applyAutostart();

  registerIpc();
  await createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

// 关掉所有窗口不等于退出：设置了「缩到托盘」时应用要继续在后台跑（服务不断）
app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (shouldKeepRunningInTray()) return;
  app.quit();
});

/**
 * 退出前先把 llama-server 停掉。
 * 不这么做的话，关掉界面会留下一个占着显存的孤儿进程 —— 下次启动就"显存莫名被占满"。
 * 所以这里拦一次退出，等 stop() 完成（内含 taskkill /T /F 兜底）再真正退出。
 */
app.on("before-quit", (event) => {
  if (quitting || session === null) {
    tray?.destroy();
    tray = null;
    return;
  }
  event.preventDefault();
  quitting = true;
  void session
    .stop()
    .catch(() => undefined)
    .finally(() => app.quit());
});
