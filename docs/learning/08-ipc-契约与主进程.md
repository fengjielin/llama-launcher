# 08 IPC 契约与主进程

> **本章目标**：看懂界面的一次点击怎么穿过三层边界到达 llama-server，以及为什么这个项目的跨边界接口只有一份、并且几乎不含逻辑。
> **主要文件**：`src/shared/ipc.ts`（400 行）、`src/preload/index.ts`（79 行）、`src/main/index.ts`（626 行）、`src/main/session.ts`（955 行）、`src/main/closePolicy.ts`（47 行）。
> **前置**：[02 项目全景与四层架构](./02-项目全景与四层架构.md)、[07 进程、日志、健康检查与指标](./07-进程-日志-健康检查与指标.md)。
>
> 行数取 read 工具的 `total`：这些文件末尾都带一个换行，所以它比「有内容的行数」多算 1 行；正文引用的行号是同一口径。

## 0. 学完这章你能回答什么

- 界面点「启动服务」时，`llama-server.exe` 是被谁、在哪一行起的？（提示：不在 `main/index.ts` 里）
- 为什么渲染层拿不到 `ipcRenderer`、也拿不到任何通道名字符串，却还能订阅日志？
- 第一次运行的默认配置是谁写的？为什么不是在 `app.whenReady()` 里主动写？
- 主进程 → 渲染层有哪三条推送通道？`onLog` 为什么返回一个函数而不是 `void`？
- 服务正在跑时点窗口 ✕，程序凭什么决定「直接退 / 藏托盘 / 问你一句」？

## 1. 先看问题

Electron 里有两类进程：**主进程**（能开窗口、能跑 `child_process`、能用 Node 的 `fs`）和**渲染进程**（跑 React 的那个页面，本质是浏览器标签）。两者内存不共享，只能靠 IPC 传消息。这带来三个麻烦：

**一：界面想干的事，主进程不一定同意。** 渲染层是一个网页。如果它能 `require("child_process")`，页面里任何一段代码（包括将来引入的第三方脚本）都能在你机器上执行任意命令 —— 所以必须有一道**白名单**，把渲染层能做的事逐个列举。

**二：两侧对「一份配置长什么样」的理解会漂移。** 界面需要 `LauncherConfig`，`core` 里已经定义好了。如果渲染层图省事自己写一个 `type MyConfig = {...}`，那么 `core` 哪天给 `mode` 加了新取值，界面这份就悄悄过期了 —— 类型检查发现不了，因为它们是两个类型。

**三：跨边界的代码最难测。** 如果 `ipcMain.handle("llama:start", ...)` 里写着「检查有没有在跑、拼命令行、找空闲端口、起进程、等端口」，这段逻辑就只能靠「打开界面点一下」来验证。纪律写在 `src/main/session.ts:4-5`：「刻意**不 import electron**：主进程只负责窗口与对话框，业务逻辑全在这个类里，于是它可以被 CLI、被单测直接驱动，而不是只能通过点界面来验证。」

## 2. 核心概念

### 2.1 IPC 契约：一份只放类型与通道名的文件

**是什么**：`src/shared/ipc.ts` 是 `main` / `preload` / `renderer` 三端共享的模块，导出两样东西：`IPC` 常量对象（通道名）和一堆 `interface`（载荷结构）。**为什么需要**：把「两侧共同认可的事实」抽到第三个地方，等于强迫双方都从它取：

```ts
// src/shared/ipc.ts:4-8
 * 这里只放**类型与通道名**：core 里的业务类型原样复用（`import type`，编译后被抹掉），
 * 避免界面层另造一套 DTO 然后跟 core 慢慢漂移。
 *
 * `LlamaApi` 是全程序唯一的前端调用面：preload 实现它，renderer 只认它。
 * 将来若把 Electron 换成别的壳，只要新壳再实现一遍这个接口即可。
```

它对 `core` 的引用**全部**是 `import type`（`src/shared/ipc.ts:11-17`，共 7 行）：这些行只用于类型检查，Node 22.18 的原生 TypeScript 类型擦除（以及任何打包）会把它们整行删掉，运行时不会真的去加载 `core` —— 所以「复用 core 的类型」和「不把 core 拖进渲染层」可以同时成立（`electron.vite.config.ts:21` 也写了这条纪律）：

```ts
// electron.vite.config.ts:21
 * core（src/core）不打进渲染层：界面只能通过 IPC 拿到数据，保证「界面不改命令行」。
```

### 2.2 `LlamaApi`：全程序唯一的前端调用面

**是什么**：一个 TypeScript 接口，列出界面能对主进程做的**全部**事情（30 个方法），定义在 `src/shared/ipc.ts:347-399`：

```ts
// src/shared/ipc.ts:347-352
/** 前端唯一调用面。preload 实现它，renderer 只依赖它。 */
export interface LlamaApi {
  bootstrap(): Promise<BootstrapPayload>;
  openConfig(): Promise<ConfigFileResult>;
  saveConfig(config: LauncherConfig): Promise<{ ok: boolean; path: string; warnings: string[] }>;
  saveConfigAs(config: LauncherConfig): Promise<{ canceled: boolean; path: string | null }>;
```

**为什么需要**：它把「换壳」的成本压到一处。`src/preload/index.ts:20` 写的是 `const api: LlamaApi = { ... }` —— 这个类型标注是硬约束：少实现一个方法，`pnpm typecheck` 立刻报错。反过来渲染层只 `import type { LlamaApi }`，从不 import `electron`；将来换成 Tauri 或别的壳，只要新壳再实现一遍这个接口，`src/renderer/**` 一行都不用改。

### 2.3 preload 与 `contextBridge`

preload 是在渲染进程里、页面脚本之前执行的一段脚本。它同时能看到页面的 `window` 和 Node 能力，所以是「唯一允许跨越边界的地方」（`src/preload/index.ts:1-6`）。**为什么需要**：它让渲染层**根本不知道** IPC 通道名长什么样。配套的是窗口设置（`src/main/index.ts:279-285`）：

```ts
// src/main/index.ts:279-285
    webPreferences: {
      preload: preloadPath,
      // ESM/CJS 混合的 preload 需要非沙箱渲染进程；安全性靠 contextIsolation + 窄 API 保证
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
```

`nodeIntegration: false` = 页面里没有 `require` / `process`；`contextIsolation: true` = preload 的世界和页面的世界被隔开，只能通过 `contextBridge` 显式搭桥。整个文件唯一一次「给出东西」就是 `contextBridge.exposeInMainWorld("llamaApi", api);`（`src/preload/index.ts:78`）—— 于是页面里能用的只有 `window.llamaApi.bootstrap()` 这 30 个方法，没有 `ipcRenderer`、没有通道名、没有 `fs`。

### 2.4 `LauncherSession`：不认识 Electron 的会话状态机

一个普通 TypeScript 类（`src/main/session.ts:97`），持有「当前配置 + 探测结果 + 进程句柄 + 日志缓冲」四类状态。它的价值是让业务逻辑脱离 Electron 运行：`src/main/index.ts:2-3` 写着主进程的自我定位 ——「只做三件事：开窗口、注册 IPC、把会话事件推给界面。业务逻辑全在 LauncherSession（不 import electron，可单测）」。

### 2.5 薄转发：`ipcMain.handle` 里不写业务

26 个 `ipcMain.handle` 几乎都长这样：把参数丢给 `LauncherSession`，把返回值丢回界面。因为它们需要 Electron 运行时、无法单测，所以逻辑越薄，不可测的面积越小：

```ts
// src/main/index.ts:414-419
 * 约定：**每个 handler 只做两件事** —— 必要时弹对话框、然后把活交给 `LauncherSession`。
 * 业务逻辑一律不写在这里（那样就没法脱离 electron 做单测了）。
 * 通道名统一取自 `IPC` 常量，避免两侧手写字符串写错。
 *
 * 错误处理策略：能展示给用户的失败（找不到 exe、拼装失败、迁移的文件不是合法 JSON）
 * 都以返回值表达；只有真正意外的异常才让它冒泡成 IPC 拒绝。
```

### 2.6 推送：主进程主动发给界面的三条通道

前面都是「界面问、主进程答」（`invoke` / `handle`）。但日志是**服务器吐出来的**，没人问也得送过去。契约里另有三条单向通道（`src/shared/ipc.ts:61-64`）：

```ts
// src/shared/ipc.ts:61-64
  /** 主进程 → 渲染层的推送 */
  pushLog: "push:log",
  pushState: "push:state",
  pushMetrics: "push:metrics",
```

它们用 `webContents.send()` 发、用 `ipcRenderer.on()` 收，3.7 节把整条线串起来。

## 3. 代码怎么走

### 3.1 契约的第一屏：通道名常量

`src/shared/ipc.ts:19-65` 是一个 `as const` 对象，每个键一类操作，值是真正的通道字符串：

```ts
// src/shared/ipc.ts:19-23
export const IPC = {
  /** 启动时拉取：配置路径、归一化配置、参数表 */
  bootstrap: "app:bootstrap",
  /** 打开已有配置 */
  configOpen: "config:open",
```

紧接着一行把它的所有值收成联合类型（`src/shared/ipc.ts:67`）：`export type IpcChannel = (typeof IPC)[keyof typeof IPC];`。**这就是「只放通道名」的价值**：两侧都写 `IPC.bootstrap`，谁也不会把 `"app:bootstrap"` 拼成 `"app:bootstap"` —— 后者运行时会安静地失败（界面一直转圈），极难查。

### 3.2 preload 怎么实现这 30 个方法

绝大多数方法是**一行**的 `() => ipcRenderer.invoke(通道名, 参数…)`：

```ts
// src/preload/index.ts:20-28
const api: LlamaApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  openConfig: () => ipcRenderer.invoke(IPC.configOpen),
  saveConfig: (config: LauncherConfig) => ipcRenderer.invoke(IPC.configSave, config),
  saveConfigAs: (config: LauncherConfig) => ipcRenderer.invoke(IPC.configSaveAs, config),
  importPresets: () => ipcRenderer.invoke(IPC.presetsImport),
  pickPath: (request: PickPathRequest) => ipcRenderer.invoke(IPC.pickPath, request),
  listModels: () => ipcRenderer.invoke(IPC.modelsList),
  detect: () => ipcRenderer.invoke(IPC.detect),
```

从 `precheck` 到 `getSettings`（`src/preload/index.ts:29-59`）全是同一个形状，只有三个订阅方法例外（下一节）。小细节值得学：`precheck` 那行（`29`）写的是 `ipcRenderer.invoke(IPC.precheck, force === true)` —— 界面传来的在类型上虽是 `boolean | undefined`，但**运行时什么都可能**（这是真正的进程边界），这一行把真值判定收窄成严格布尔；handler 侧也有同样的写法（`src/main/index.ts:426` 的 `force === true`、`511` 的 `active === true`）。

### 3.3 订阅类方法为什么返回函数

`onLog` / `onState` / `onMetrics` 不返回数据，而是**返回一个函数**：

```ts
// src/preload/index.ts:61-65
  onLog(handler: (entry: LogPush) => void) {
    const listener = (_event: unknown, entry: LogPush): void => handler(entry);
    ipcRenderer.on(IPC.pushLog, listener);
    return () => {
      ipcRenderer.removeListener(IPC.pushLog, listener);
    };
  },
```

先把 `handler` **包一层**成 `listener` —— `ipcRenderer.on` 的回调第一个参数是 Electron 的事件对象，界面只想拿第二参数。然后注册，最后返回「撤销动作」。**为什么必须返回函数**：`removeListener` 需要**同一个函数引用**，直接 `removeListener(IPC.pushLog, handler)` 是删不掉那个包装函数的。`onState`（`69-75`）与 `onMetrics`（`42-48`）是同一个模式。界面那边确实收着并调用了（`src/renderer/src/hooks/useLauncher.ts:298-305`）：

```ts
// src/renderer/src/hooks/useLauncher.ts:298-302
    return () => {
      disposed = true;
      offLog();
      offState();
      offMetrics();
```

顺手还有一行 `void api.metricsWatch(false);`（`304`）——「离开界面就关掉指标采样」（见 [07 进程、日志、健康检查与指标](./07-进程-日志-健康检查与指标.md)）。

### 3.4 `registerIpc()`：26 个 handler 的分工

先核实数量：`src/main/index.ts` 里 `ipcMain.handle` 出现 26 次，通道名两两不重复。行号是该 handler 的起始行：

| 类别 | 通道（起始行） |
| --- | --- |
| 薄转发，一行 `s().xxx()` | `bootstrap` 424、`detect` 425、`precheck` 426、`preview` 427、`start` 428、`stop` 429、`status` 430、`health` 431、`logsRecent` 432、`configSave` 434、`modelsList` 479、`metricsSnapshot` 509、`metricsWatch` 511、`profilesList` 514、`profilesSave` 515、`profilesLoad` 516、`profilesDelete` 517 |
| 先弹系统对话框 | `configSaveAs` 436、`configOpen` 447、`presetsImport` 460、`pickPath` 482 |
| 系统能力 / 建目录 | `openWebUi` 497、`revealPath` 503、`profilesReveal` 518（`mkdirSync` 后才 `shell.openPath`） |
| 纯本进程状态，不碰会话 | `settingsGet` 527、`settingsSet` 528 |

挑四个有代表性的展开。**(1) `bootstrap`（`424`）—— 最薄也最重要**：

```ts
// src/main/index.ts:422-424
  const s = (): LauncherSession => getSession();

  ipcMain.handle(IPC.bootstrap, () => s().bootstrap());
```

它一行，却是界面能画出来的前提 —— `s` 是**函数**而不是变量：每次调用都重新问一次 `getSession()`（懒加载单例，`113-133`）。

**(2) `start`（`428`）—— 真正把活交出去的那一行**：

```ts
// src/main/index.ts:428
  ipcMain.handle(IPC.start, (_e, config: LauncherConfig) => s().start(config));
```

「启动 llama-server」这件听起来最重的事只有一行。真正的编排在 `LauncherSession.start`（`src/main/session.ts:554`）：先 `preview` 拼命令行 → 端口被占就顺延（`566-581`）→ 跑一次环境自检 → 清空日志缓冲（`596-597`）→ `this.server.start({...})`（`599`）。`session.ts` 根本不知道自己是被人点界面还是被 CLI 调起来的。

**(3) `preview`（`427`）—— 界面每改一个参数就走一次**：

```ts
// src/main/index.ts:427
  ipcMain.handle(IPC.preview, (_e, config: LauncherConfig) => s().preview(config));
```

它和 `start` 共用 `prepareLaunch`，所以「看到的命令」永远等于「启动的命令」。会话侧有个关键行为（`src/main/session.ts:524-527`）：

```ts
// src/main/session.ts:523-526
    // 换了 llama.cpp 目录或还没探测过 → 先探测，否则拼出来的参数名可能是别的版本的名字
    if (this.capsRaw === null || this.capsKey !== this.capsKeyFor(config)) {
      this.config = config;
      const detected = await this.detect();
```

所以界面不需要强制用户先点一次「重新探测」，`preview` 会自己补上。

**(4) `presetsImport`（`460`）—— 唯一带 `try/catch` 的 handler**：

```ts
// src/main/index.ts:466-476
    const path = picked.filePaths[0];
    if (picked.canceled || path === undefined) return { canceled: true, path: null, payload: null, warnings: [] };
    try {
      const payload = s().importPresetsFromFile(path);
      return { canceled: false, path, payload, warnings: payload.warnings };
    } catch (err) {
      // 选错文件 / 文件坏了不该让界面崩掉：退回当前状态并把原因放进 warnings
      const message = err instanceof Error ? err.message : String(err);
      const payload = s().bootstrap();
      return { canceled: false, path: null, payload, warnings: [`导入失败：${message}`] };
    }
```

它体现了 2.5 节的错误策略：**能展示给用户的失败用返回值表达** —— 用户选了损坏的 ini，`importPresetsFromFile` 会抛（`src/main/session.ts:362` 的 `readFileSync`），但界面不该崩：这里接住它、退回当前状态、把原因放进 `warnings`，界面收到的是与成功时**同一形状**的载荷。还有一条顺序要求：`registerIpc()` 在 `app.whenReady()` 里、`createWindow()` **之前**（`592-593`），因为窗口一加载渲染层立刻就会 `invoke` `IPC.bootstrap`。

### 3.5 `LauncherSession` 的职责地图

私有字段（`src/main/session.ts:98-115`）就是它的全部家当：`configPath` / `config` / `configWarnings` / `configNotices`（**配置**）、`capsRaw` / `capsKey` / `exe` / `lastPrecheck` / `precheckKey`（**探测缓存**）、`server`（**进程句柄**）、`logSeq` / `logBuffer` / `lastPreview` / `sampler`（**日志与预览**）、`events`（注入的回调）。字段上方的分隔注释（`138`、`482`、`507`、`540`、`651`、`816`、`878`）就是公开方法的分组地图：

| 分组 | 方法（行号） |
| --- | --- |
| 配置读写 | `bootstrap` 145、`openConfig` 296、`importPresetsFromFile` 361、`listModels` 396、`saveConfig` 422、`getConfigPath` 437 |
| 探测与预检 | `detect` 493、`precheck` 737 |
| 预览与启停 | `preview` 522、`start` 554、`stop` 632、`startCurrent` 647 |
| 状态与健康 | `health` 673、`status` 686、`servingSummary` 710 |
| 日志缓冲 | `recentLogs` 724、`recentLines` 812 |
| 指标 / 档案 | `metricsSnapshot` 858、`watchMetrics` 871、`profilesDir` 881、`listProfiles` 890、`saveProfile` 904、`loadProfile` 918、`deleteProfile` 950 |

两条纪律值得单独记。**纪律一：主进程不自己拼命令行。** `start()` 的第一步是调 `this.preview(config)`（`557`），而 `preview()` 里调的是 `prepareLaunch`（`530`）—— 命令行只有**一个**生成点，这就是「看到的命令 === 启动的命令」的落点；回给界面的 `lastCommand` 也是上次预览的结果（`695`）：`lastCommand: this.lastPreview?.command ?? null,`。

**纪律二：关窗路径不问网络。** `servingSummary()` 专门为关窗而写（`710-717`）：它只读 `this.server.getState()` 与 `getPid()`，**不**请求 `/health`（那种请求在服务卡住时可能等好几秒，而用户点 ✕ 时不该等网络，注释在 `701-703`）。`active` 的判定是 `state === "starting" || state === "running" || state === "stopping"` —— 启动中直接退会把刚加载的模型扔掉，所以它也算「活着」。

### 3.6 主进程启动顺序

`src/main/index.ts` 的**模块体**（不在任何函数里）在 `app` ready 之前做三件事。**(1) 解析应用目录（`61-64`）**：

```ts
// src/main/index.ts:61-64
const appDir = resolveAppDir({
  portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  exePath: app.getPath("exe"),
});
```

`resolveAppDir` 是纯函数（`src/main/paths.ts:46-56`）：有 `PORTABLE_EXECUTABLE_DIR` 就用它，否则用 exe 所在目录。**为什么不能直接用 `app.getPath("exe")`**：单文件便携版每次启动都把自己解压到 `%TEMP%\<随机名>\`，拿它当应用目录的后果写在 `src/main/paths.ts:36-39`（「便携版每次启动配置都被重置」，原文标注「实测确认过」）。

**(2) 决定数据落点（`76-81`）**：

```ts
// src/main/index.ts:76-81
const layout = chooseDataLayout({
  isPackaged: app.isPackaged,
  exeDir: appDir,
  projectDir: app.getAppPath(),
  defaultUserDataDir: () => app.getPath("userData"),
});
```

紧接着 `if (layout.portable) app.setPath("userData", layout.dataDir)`（`82-86`）。两个容易看漏的点：`defaultUserDataDir` 传的是**箭头函数**而不是字符串 —— 因为 `app.getPath("userData")` 这个调用本身就会把 `%APPDATA%\<应用名>` 建出来，惰性求值才能让它在便携模式下彻底不出现（`72-74`）；而 `app.setPath("userData", ...)` **必须早于 ready**，晚了就改不动了（`69-70`）。决策的三条分支在 `src/main/paths.ts:135-160`：开发模式用项目目录；打包后 exe 目录可写 → 便携模式；不可写 → 退回 userData。

**(3) 定下配置路径 —— 只是一个 getter（`98-100`）**：`return layout.configPath;`。

**[重要澄清] 首次运行的默认配置不在这里生成。** `app.whenReady()` 的回调（`585-590`）只做设置文件与自启对账：

```ts
// src/main/index.ts:585-590
app.whenReady().then(async () => {
  // 设置文件必须放在 userData 下：打包后安装目录是只读的
  settingsPath = settingsPathFor(app.getPath("userData"));
  settings = loadSettings(settingsPath);
  // 与系统登录项对一次账（用户可能在系统设置里改过）
  applyAutostart();
```

之后才是 `registerIpc()` / `await createWindow()` / `createTray()`（`592-594`）。生成默认配置发生在**第一次 `bootstrap()` 被调用时** —— 也就是窗口加载完、渲染层发出第一次 `invoke` 之后。链路是 `IPC.bootstrap`（`424`）→ `LauncherSession.bootstrap()`（`src/main/session.ts:145-148`）→ `reloadConfig()`，而它第一句就是「文件不存在？」（`175`）：

```ts
// src/main/session.ts:175-176
    if (!existsSync(this.configPath)) {
      const layout = discoverModelLayout({ startDirs: this.searchStartDirs() });
```

`discoverModelLayout`（`src/core/config.ts:563`）去找 llama.cpp 目录、`models` 目录和 `presets.ini`，探到的结果写进新配置（`src/main/session.ts:187-194`，含 `llama_dir` / `mode` / `models_dir` / `presets` / `preload_model`）。写盘之后还有一步很讲究的操作 —— **把它当普通配置文件重新读一遍**（`212-214`）：

```ts
// src/main/session.ts:212-214
      const reloaded = loadConfigFile(this.configPath);
      this.config = reloaded.config;
      this.configNotices = [`首次运行：已在 ${this.configPath} 生成默认配置（可以直接编辑这个文件）`];
```

为什么值得多读一次？注释给了答案（`160-166`）：这样「首次运行的内存状态」与「第二次启动读文件的状态」完全一致，不会出现「这次能用、下次启动表现不同」的怪现象。探到的东西最后逐条变成 `notices`（`216-234`），界面上显示「已自动探测到 llama.cpp 目录：…」这类好消息 —— 它们与 `warnings` 分开存放，因为「刚生成好配置」不该被渲染成警告。

### 3.7 三条推送通道的完整连线

```mermaid
graph LR
    A[LlamaServer 子进程] --> B[LauncherSession 回调]
    B --> C[main index 转发]
    C --> D[webContents send]
    D --> E[preload 监听]
    E --> F[renderer 订阅]
```

**起点**是会话的 `events` 字段（`src/main/session.ts:68-76`）：三个**可选**回调 `onLog` / `onState` / `onMetrics`，调用点一律用 `?.` —— 会话不认识 Electron，没人订阅时它照样能跑（CLI 就是这么用的）。**`onLog` 触发点**在 `start()` 给 `this.server.start` 传的 `onLine` 回调里（`605-612`）：

```ts
// src/main/session.ts:605-612
      onLine: (line, event) => {
        this.logSeq += 1;
        const push = toLogPush(this.logSeq, Date.now(), line, event);
        this.logBuffer.push(push);
        if (this.logBuffer.length > LOG_BUFFER_LIMIT) {
          this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_LIMIT);
        }
        this.events.onLog?.(push);
```

自增序号 → 包成 `LogPush`（`src/main/payload.ts:207-209`）→ 进环形缓冲（上限 `LOG_BUFFER_LIMIT = 4000`，`src/main/session.ts:66`）→ 推出去。环形缓冲就是「界面刚打开时补历史」的数据源（`724-726`，返回的是**副本**）。

**`onState` 触发点**在 `616-619`；推出去的 `health` 固定是 `null`，因为**状态推送不带健康信息** —— 健康由界面轮询 `status()` 拿（`72` 的注释）：「进程状态变了」是事件，而「`/health` 现在返回什么」是另一回事，混在一起会让推送频率不可控：

```ts
// src/main/session.ts:616-619
      onState: (state, note) => {
        this.metricsSampler().setServerState(state);
        this.events.onState?.({ state, note, health: null });
      },
```

**`onMetrics` 触发点**在采样器懒创建时（`825-833`）：构造 `MetricsSampler` 时传 `onSample: () => this.events.onMetrics?.(this.metricsPayload(sampler))`（`829`），每次推**完整载荷**（含整段历史序列，`837-844`）。

**第二跳**：`main/index.ts` 把回调接到窗口上，位置在 `getSession()` 里（`src/main/index.ts:115-125`）：

```ts
// src/main/index.ts:115-125
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
```

`onState` 在这里顺手刷新了托盘图标 —— 会话只管发事件，谁需要谁接，这就是「主进程负责窗口与系统集成」的样子。`win?.` 的空值保护有原因（`109`）：窗口可能已经关了。`getSession()` 是**懒加载**的，所以这三条连线在第一次有人要会话时才建立。

**第三跳**是 preload 的 `ipcRenderer.on`（`src/preload/index.ts:61-75`，3.3 节已逐行看过）。**第四跳**是渲染层订阅（`src/renderer/src/hooks/useLauncher.ts:285-296`）：

```ts
// src/renderer/src/hooks/useLauncher.ts:285-296
    const offLog = api.onLog((entry) => {
      setLogs((prev) => {
        const next = prev.length >= LOG_LIMIT ? prev.slice(prev.length - LOG_LIMIT + 1) : [...prev];
        next.push(entry);
        return next;
      });
    });
    const offState = api.onState((push) => {
      setStatus((prev) => (prev === null ? prev : { ...prev, state: push.state, note: push.note }));
    });
    // 指标推送：载荷里已带完整历史序列，直接替换即可
    const offMetrics = api.onMetrics((payload) => setMetrics(payload));
```

还有个容易漏的顺序问题：**订阅必须在会推数据之前挂上**。这里订阅在 `285`、拉历史在 `259`，而 `259` 在一个 `await` 之后的异步块里、订阅是同步注册的，所以顺序天然正确。界面层细节见 [09 React 界面层](./09-react-界面层.md)。

### 3.8 智能 ✕：`decideCloseAction`

窗口的 `close` 事件自己不做判断（`src/main/index.ts:296-302`）：

```ts
// src/main/index.ts:296-302
  win.on("close", (event) => {
    // 关窗要不要拦下来，交给纯函数判（每种组合都有单测，见 closePolicy.ts）
    const action = decideCloseAction({
      minimizeToTray: settings.minimizeToTray,
      quitting,
      serverActive: session?.servingSummary().active === true,
    });
```

判断在 46 行的纯函数里（`src/main/closePolicy.ts:41-46`）：

```ts
// src/main/closePolicy.ts:41-46
export function decideCloseAction(input: CloseDecisionInput): CloseAction {
  if (input.quitting) return "close";
  if (input.minimizeToTray) return "hide-to-tray";
  if (!input.serverActive) return "close";
  return "ask";
}
```

**三种返回值**（`10-16`）：`"close"` 放行关闭；`"hide-to-tray"` 拦下并隐藏；`"ask"` 拦下并问用户一次。**三个输入**（`19-26`）：设置的 `minimizeToTray`、是否已在退出流程（`quitting`）、服务是否还活着（`serverActive`）。

**四个判断的顺序有意义**，最关键的是第一条（`32`）：「**已在退出流程中** → `close`：这时再拦一次就永远退不掉了」——`before-quit` 会先 `preventDefault()`、`stop()` 再 `app.quit()`（`src/main/index.ts:613-625`），最后那次 `app.quit()` 又引发一轮 `close`；那时若再拦成 `ask`，程序就卡死了。

**为什么抽成纯函数**（`src/main/closePolicy.ts:3-6`）：「这是全应用最容易误伤用户的一处 —— 判错一次，要么正在跑的模型被悄悄停掉，要么用户以为关了程序、进程却还在后台。把决策与副作用（弹框、隐藏窗口、退出）分开，就能用单测把每种组合钉住。」「纯」= 不读全局、不碰 `settings`、不调 `app`，只吃 3 个布尔、吐 1 个字符串，所以能穷举：`src/test/closePolicy.test.ts:28-34`（由 `src/test/run-tests.ts:34-35` 引入）。`"ask"` 那一支的副作用在 `askBeforeQuittingWhileServing()`（`src/main/index.ts:555-583`）：三个按钮「退出并停止服务 / 缩到托盘继续跑 / 取消」，并用 `closePromptOpen` 标志保证连点 ✕ 不叠框（`539-540`）。

### 3.9 托盘与退出

托盘由 `TrayController` 封装（`src/main/tray.ts:57`）。`update(next)` 合并状态后整份重建图标、tooltip 与右键菜单（`98-101`、`119-156`）—— 注释解释了为什么不搞差量比较：Electron 的 `setContextMenu` 本来就是整份替换，整份重建反而不会出现「某项该灰却还可点」（`53-56`）。主进程只负责接线（`src/main/index.ts:226-248`），且被 `try/catch` 包住 —— 托盘起不来不该让程序起不来（`249-252`）。退出路径有两处与本章相关：`window-all-closed` 里先放行 macOS 与「缩到托盘」模式，否则才 `app.quit()`（`601-606`）；`before-quit` 则把 `quitting` 置 `true`、`stop()` 完再退（`619-624`）：

```ts
// src/main/index.ts:619-624
  event.preventDefault();
  quitting = true;
  void session
    .stop()
    .catch(() => undefined)
    .finally(() => app.quit());
```

那句 `quitting = true` 就是 3.8 节第一条规则的来源。`installUiExport(win)`（`338`，调用在 `314`）是无人值守的界面自检入口，由主进程安装，细节见 [09 React 界面层](./09-react-界面层.md)；这里只提醒一个坑：它必须挂在 `loadFile()` **之前**，因为 `await loadFile()` 是在 `did-finish-load` 之后才 resolve，挂晚了永远等不到事件（`312-314`）。

## 4. 踩过的坑与设计取舍

> **「便携版每次启动配置都被重置」** —— 单文件便携版每次启动都把自己解压到 `%TEMP%\<随机名>\`，`app.getPath("exe")` 指的是那里，拿它当应用目录就会把配置写进临时目录（`src/main/paths.ts:36-39`，原文标注「实测确认过」）。

> **`app.getPath("userData")` 一调用就会建目录** —— `defaultUserDataDir` 必须传函数而不是字符串，才能让 `%APPDATA%\<应用名>` 在便携模式下彻底不出现；`app.setPath("userData", ...)` 则必须早于 ready，晚了就改不动（`src/main/index.ts:69-74`，两处注释都标了「实测」）。

> **关窗默认不再缩托盘（但也不能偷偷把模型杀了）**（`README.md:429-430`）：
> ```markdown
> 早先的默认是「关窗即缩到托盘」，结果是"明明点了 ✕，任务管理器里四个进程还在"，很吓人。
> 现在默认**不缩托盘**，改成按情况处理，决策逻辑在 `src/main/closePolicy.ts`（纯函数，有单测）：
> ```

> **监听必须挂在 load 之前**（`src/main/index.ts:312-313`）：
> ```ts
>   // ⚠ 监听必须挂在 load 之前：await loadFile() 是在 did-finish-load 之后才 resolve 的，
>   //   挂晚了就永远等不到事件（实测会一直不退出）。
> ```

> **`electron` 不显式外部化就会被打进 bundle**（`electron.vite.config.ts:14-15`）：`externalizeDepsPlugin` 只外部化 `dependencies`，而 electron 装在 `devDependencies` 里；不外部化的话 rollup 会把整个 npm 包打进去，而那个包的 `index.js` 会去解析二进制路径、找不到就现场下载，结果启动即报 "Electron failed to install correctly"（注释标注「本地实测踩过」）。

**关于「单实例锁」**：我在 `src/**` 里搜过 `requestSingleInstanceLock` 与 `second-instance`，**没有找到任何匹配** —— 这个项目目前没有申请单实例锁，所以理论上可以同时打开两个启动器窗口（它们各持一份 `LauncherSession`，互相不知道对方在跑 llama-server）。这条留给你自己核实并展开：见 `src/main/index.ts:585-599`。README 那句「任务管理器里看到 4 个 `llama-launcher.exe` 是正常的：那是 Electron 一个应用的进程族」（`README.md:439-440`）指的是同一实例内部的进程族，不是单实例锁。

## 5. 动手练习

### 练习 1（易）：给 `decideCloseAction` 加一个输入

**任务**：现在 `"ask"` 这一支对「服务在跑」与「服务正在启动」一视同仁。给 `CloseDecisionInput` 加一个输入（比如 `starting: boolean`），改一条规则并**先写测试**。

**提示**：改 `src/main/closePolicy.ts:19-26`（输入接口）与 `41-46`（决策）；测试改 `src/test/closePolicy.test.ts`；调用点在 `src/main/index.ts:298-302` —— `servingSummary()` 已经返回了 `state`，可以从它区分 `starting` 与 `running`（`src/main/session.ts:710-717`）。

**验收标准**：`pnpm test` 全绿、`pnpm typecheck` 0 错，且新规则在 `closePolicy.test.ts` 里至少有两个 `assert.equal` 覆盖。这条练习不需要启动 Electron。

### 练习 2（中）：加一条新的推送通道

**任务**：现在 `lastCommand`（最近生效的命令行）只在轮询 `status()` 时更新。新增一条推送通道，让主进程在每次 `start()` 完成后把最新命令推给界面。

**提示**：四处都要改，缺一处 `pnpm typecheck` 就会拦住你 ——
1. `src/shared/ipc.ts:61-64` 加 `pushCommand`，`347-399` 的 `LlamaApi` 加 `onCommand(handler): () => void`；
2. `src/preload/index.ts:69-75` 照着 `onState` 写一份；
3. `src/main/index.ts:115-125` 的 `onState` 旁边加转发（或在 `IPC.start` 的 handler 里发）；
4. `src/renderer/src/hooks/useLauncher.ts:285-305` 订阅，并在清理函数里调用返回的取消函数。

**验收标准**：`window.llamaApi` 上能列出新增的方法；界面启动服务后，顶栏的命令行不用等下一次轮询就更新。看效果需要 `pnpm dev`。

### 练习 3（难）：验证懒加载的时机

**任务**：用**只读**的方式证明「从 `app.whenReady()` 到窗口出现为止，`LauncherSession` 的构造函数被调用了几次、由谁触发」。

**提示**：不要为了验证就改源码提交 —— 本地临时加 `console.log`、验证完撤掉，或者纯靠读代码回答。要看的点：`src/main/index.ts:592-593` 的注册与建窗顺序；`installUiExport`（`338`）内部用的是 `session?.`；`src/main/index.ts:301` 的 `session?.servingSummary()` 在窗口刚建时 `session` 还是 `null`；真正造出 `session` 的是渲染层的第一次 `invoke`（`424`）。

**验收标准**：你能一句话说出「第一个触发 `getSession()` 的调用来自哪一端、哪一行」，并解释为什么 `src/main/index.ts:301` 用的是可选链。

## 6. 自测题

**第 1 题**：`src/shared/ipc.ts` 里对 `core` 的引用为什么可以用 `import type`？改成普通 `import` 会有什么后果？

<details>
<summary>第 1 题答案</summary>

因为 `ipc.ts` 只在**类型位置**使用 core 的东西（`LauncherConfig` 当参数类型、`LogEventKind` 当字段类型），运行时一个都不需要；`import type` 会被类型擦除 / 打包整行删掉，所以 `core` 不会进渲染层 bundle —— 这与 `electron.vite.config.ts:21` 的「core 不打进渲染层」是同一件事的两面。改成普通 `import` 后 `core` 的代码会真的进渲染层 bundle，「界面不能自己拼命令行」这条物理保证就没了。

</details>

**第 2 题**：渲染层在自己的代码里写 `ipcRenderer.invoke("app:bootstrap")` 会怎样？为什么？

<details>
<summary>第 2 题答案</summary>

会直接抛 `ReferenceError: ipcRenderer is not defined`。窗口的 `webPreferences` 写了 `nodeIntegration: false` 和 `contextIsolation: true`（`src/main/index.ts:283-284`），渲染层没有 Node 能力；preload 也只在 `window` 上挂了 `llamaApi` 一个对象（`src/preload/index.ts:78`），从没把 `ipcRenderer` 或 `IPC` 常量交出去 —— 这正是设计意图（`3-4`：「不给渲染层任何 IPC 通道名」）。

</details>

**第 3 题**：`ipcMain.handle(IPC.start, ...)` 只有一行，那「端口被占用就顺延」的逻辑在哪里？为什么放那里？

<details>
<summary>第 3 题答案</summary>

在 `LauncherSession.start()`，`src/main/session.ts:566-581`：先 `probeTcp` 探目标端口，被占就 `findFreePort` 找下一个，然后**同步改写命令行里的 `--port`**，并把这条信息追加进 `warnings`。放那里的原因是可测性 —— `ipcMain.handle` 的回调只有 Electron 运行时才能跑，而 `LauncherSession` 不 import electron，能被 CLI 和单测直接驱动（`4-5`）。

</details>

**第 4 题**：`LauncherSession` 的 `onState` 推出去的载荷里，`health` 为什么永远是 `null`？

<details>
<summary>第 4 题答案</summary>

因为状态推送与健康检查是两种不同频率的信息（`src/main/session.ts:618` 写死 `health: null`，注释在 `72`）。进程状态变化是**事件**，而 `/health` 是一个可能耗时、可能超时的 HTTP 请求；`status()` 由界面按固定节奏轮询，且只在 `running` 时才真的去请求（`694`）。

</details>

**第 5 题**：为什么 `decideCloseAction` 的第一个判断是 `if (input.quitting) return "close"`？删掉会怎样？

<details>
<summary>第 5 题答案</summary>

因为退出流程会再次触发 `close`：`before-quit` 里为了先停服做了 `event.preventDefault()` → `quitting = true` → `stop()` → `app.quit()`（`src/main/index.ts:613-625`），而最后那次 `app.quit()` 又引发一轮窗口 `close`。删掉它之后，如果用户开着「缩到托盘」或服务还在跑，这一轮又会被拦成 `hide-to-tray` 或 `ask` —— 窗口关不掉、`app.quit()` 等不到，程序卡死。`src/main/closePolicy.ts:32` 的注释就是这句话，`src/test/closePolicy.test.ts:28-34` 用穷举把这条分支钉住了。

</details>

## 下一章

契约把两侧隔开了，但界面拿到载荷之后怎么组织状态、怎么切组件、怎么做「自动截图测试」——那是渲染层自己的故事：[09 React 界面层](./09-react-界面层.md)。
