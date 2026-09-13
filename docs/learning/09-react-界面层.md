# 09 React 界面层

> **本章目标**：状态住在哪、组件怎么分工、「无人值守界面自检」怎么做。
> **主要文件**：`src/renderer/src/hooks/useLauncher.ts`（699 行）、`src/renderer/src/App.tsx`（149 行）、
> `components/ParamsForm.tsx`（241 行）、`components/MetricsPanel.tsx`（307 行）、`components/LogPane.tsx`（131 行）、
> `src/main/index.ts`（626 行，只看 `installUiExport`）。
> **前置**：[02 项目全景与四层架构](./02-项目全景与四层架构.md)、[08 IPC 契约与主进程](./08-ipc-契约与主进程.md)。

## 0. 学完这章你能回答什么

- 为什么整个界面只有 `useLauncher()` 一个地方在调 `window.llamaApi`？
- `busy` / `flash` / `error` 三种反馈各解决什么问题？为什么光有 `error` 不够？
- 订阅日志返回的那个「取消订阅函数」忘了调，会看到什么现象？
- 三个徽标「本版本不支持」「已废弃」「preset 接管」分别代表什么？为什么有一个只在「有值」时才显示？
- `LLAMA_LAUNCHER_UI_DUMP` 怎么在没人盯着屏幕时把界面「拍下来」并退出？

## 1. 先看问题

假设没有 `useLauncher()`，最直觉的写法是每个组件自己调 API：

```text
TopBar → api.detect()        ParamsForm → api.bootstrap()
ModelPanel → api.listModels()    DecisionTable → api.preview(config)
StatusBar → setInterval(api.status)
```

这么写会立刻遇到四类麻烦：**同一份数据被请求多次**（`ParamsForm` 改了 `config`，
`DecisionTable` 怎么知道要重拼命令行？）；**谁在改配置**（表单改字段、`pick()` 选完路径、
载入档案三处都在改，各自 `setState` 很快会出现「左边显示 A、右边显示 B」）；**订阅没人管**
（日志是主进程 push 的，漏一个 `off()` 日志就多一份）；**界面会开始自己拼命令行**
（于是「界面上看到的命令」和「实际启动的命令」可能不一致 —— 这正是本项目最想避免的事）。

答案是：**把「状态 + 动作」全部收进一个自定义 Hook，UI 组件只负责画。**

## 2. 核心概念

### 2.1 状态中枢 `useLauncher()`

返回 `LauncherController` 的 Hook，持有界面需要的**全部**状态与动作，是唯一状态源。
`useLauncher.ts:121-122` 写着理由：「界面从不自己拼参数，所以"界面上看到的命令"和
"实际启动的命令"永远是同一条」。入口在 `:130`，返回类型在 `:38-106`，真返回值在 `:650-697`。

### 2.2 单向数据流

`config` →（防抖 350 ms）→ `api.preview(config)` → `preview`（含决策表）→ 表格 / 命令行栏。
命令行的唯一真相在 `core/args.ts`，渲染层只画不算（`useLauncher.ts:315-336`、`CommandBar.tsx:8`）。

### 2.3 三类反馈

| 状态 | 语义 | 生命周期 | 界面表现 |
| --- | --- | --- | --- |
| `busy` | 有动作正在跑 | 动作开始置位，`finally` 清掉 | 按钮置灰 + 状态栏「进行中：xxx」 |
| `flash` | 动作**成功**但界面看不出变化 | 6 秒后自动消失，可手动关 | 顶栏下方天蓝色横幅 |
| `error` | 出错了 | 直到用户点「知道了」 | 顶栏下方玫红色横幅 |

声明在 `useLauncher.ts:135-136`、`:161-163`，行为见 3.4。

### 2.4 `run()` 动作包装

把「置忙 → 清旧错误 → 执行 → 捕获异常 → 解除忙碌」固定下来（`useLauncher.ts:358-368`），
每个动作只写成功路径，异常也不会冒泡进 React。

### 2.5 订阅与清理

日志 / 状态 / 指标是主进程 **push** 的。挂载时 `ipcRenderer.on(...)`，卸载时必须 `removeListener(...)`
—— `src/preload/index.ts:61-75` 返回的就是那个清理函数。

### 2.6 局部状态 vs 全局状态

只有「多个组件都要看」的才进 `useLauncher`；折叠、过滤、自动滚动、当前标签页留在组件内。
理由见 `ParamsForm.tsx:159`：塞进配置会白触发一次「重拼命令行」。

## 3. 代码怎么走

### 3.1 拿到 API，并优雅处理「没有 API」

`src/renderer/src/api.ts:8-11` 只有四行：`getApi()` 在 `typeof window === "undefined"` 时返回 `null`，
否则返回 `window.llamaApi ?? null`。`env.d.ts:5-9` 把它声明成可选；真正挂它的是 preload 的
`contextBridge.exposeInMainWorld("llamaApi", api)`（`src/preload/index.ts:78`）。
所以在浏览器里直接打开构建产物不会抛 TypeError，而是走 `bridgeMissing` 分支给人话提示（`App.tsx:33-51`）。

### 3.2 状态分几类

`useLauncher.ts:134-167` 声明了 20 多个 state，按用途分五组（括号里是声明行号）：

- **A 初始化 / 桥**：`bridgeMissing`（`:132`）、`ready`（`:134`）。`ready` 为 `false` 时
  `App.tsx:53-55` 只渲染一行「正在初始化…」，用「不渲染半成品」换「不会看到残缺的表单」。
- **B 配置与参数表**：`configPath`（`:137`）、`config`（`:138`）、`schema`（`:139`）、`warnings`（`:140`）、
  `notices`（`:142`）、`suggestions`（`:165`）、`models`（`:167`）。`warnings`（⚠ 问题）与
  `notices`（ℹ 中性通知）**故意分开**：「首次运行已生成默认配置」不该被渲染成警告（`:141`）。
- **C preview / 决策表 / 启动结果**：`preview`（`:145`）、`previewError`（`:146`）、`lastStart`（`:147`）、`logs`（`:148`）。
- **D 状态 / 指标 / 自检 / 档案 / 设置**：`status`（`:149`）、`metrics`（`:150`）、`profiles`（`:151`）、
  `profilesDir`（`:152`）、`settings`（`:153`）、`precheck`（`:154`）。
- **E 反馈与探测**：`busy`（`:135`）、`error`（`:136`）、`flash`（`:161`）+ 定时器 `flashTimer`（`:163`）、
  `detect` / `detectError`（`:143-144`）。

`flash` 上方就是它存在的理由（`useLauncher.ts:158-159`）：「有些操作"成功了但界面看不出变化"
……没有反馈时用户会当成按钮坏了」。

### 3.3 初始化那条线：`bootstrap → ready`

初始化全写在一个 `useEffect` 里（`useLauncher.ts:246-306`），按顺序 await 五件事：`bootstrap` →
`recentLogs` → `status` → `refreshSchema` → `refreshProfiles` / `getSettings` → `precheck(false)`。
五步之间全都插了同一句 `if (disposed) return;`（例如 `:256`、`:260`），`reloadFrom(boot)` 是落地点（`:257`）。
`useLauncher.ts:244-245` 解释了它的作用：「订阅的清理函数同样在卸载时执行，因此 React StrictMode
的双次调用是安全的（不会留下两份监听）」。拿不到 API 时走另一条分支，那里**照样把 `ready` 置 `true`**
（`:247-251`）—— `ready` 的语义是「初始化流程已结束」，不是「初始化成功了」。

`reloadFrom` 用**整体替换**而不是逐字段 `setState`（`useLauncher.ts:177-185`：`configPath` / `config` /
`schema` / `warnings` / `notices` / `suggestions` 六个一起换）。理由在 `:171-173`：「这些载荷代表
"换了一份配置"，逐字段更新容易出现"配置换了但参数表还是旧的"」。它被三处调用：初始化（`:257`）、
打开配置（`:493`）、载入档案（`:610`）。

### 3.4 三类反馈怎么统一处理

`run()`（`useLauncher.ts:358-368`）是 `busy` 和 `error` 的唯一入口：`setBusy(label)` → `setError(null)`
→ `try { await fn() } catch (err) { setError(message(err)) } finally { setBusy(null) }`。
于是 `start`（`:424-439`）、`stop`、`save`（`:458-471`）、`saveAs`、`openConfig`、`importPresets`
全都是 `run("名字", async () => {...})`。`busy` 的两个落点 —— 状态栏 `StatusBar.tsx:50` 的
「进行中：{busy}」，以及按钮 `disabled={busy !== null}`（`TopBar.tsx:47`；置灰视觉来自 `ui.tsx:55`
的 `disabled:opacity-40`）。

`flash` 是「成功但看不出变化」的解药（`useLauncher.ts:213-216`：先 `clearTimeout` 旧的，
再 `setFlash(text)`，然后 `window.setTimeout(() => setFlash(null), 6000)`）；`dismissFlash` 传 `null`（`:569`）。
`reprobe()` 是它最典型的用户，注释（`:373-376`）写着为什么：「`refreshSchema()` 本身不设 `busy`、
也不报结果，而重新探测同一份 llama.cpp 得到的参数表**与上次一模一样** —— 于是点了按钮界面上
一点变化都没有，看起来就像"按钮无效"（实测：探测确实跑了 367ms，但状态栏与顶栏文案一字未变）」。

它用 `run("重新探测", ...)` 包住 `refreshSchema()`（`:378-390`），再用 `flashMessage` 报结果（`:391-402`）
—— 摘要文案交给纯函数 `summarizeDetect`（`src/core/format.ts:35`），不是手拼的。
三条反馈在 `App.tsx` 里的落位：`busy` 在底部状态栏（`:145`），`flash` 与 `error` 是顶栏下面两条
互不冲突的横幅（`:78-96`），一个 `border-sky-900/50`、一个 `border-rose-900/50`，都带「知道了」按钮。

### 3.5 订阅与清理：`onLog` / `onState` / `onMetrics`

```ts
// src/renderer/src/hooks/useLauncher.ts:286-290
      setLogs((prev) => {
        const next = prev.length >= LOG_LIMIT ? prev.slice(prev.length - LOG_LIMIT + 1) : [...prev];
        next.push(entry);
        return next;
      });
```

三个订阅在 `useLauncher.ts:285-296`：日志往数组尾部追加并**截断**（上面这段）；状态用
`{ ...prev, state: push.state, note: push.note }` **合并**进旧快照（`:293`）；指标整体替换（`:295`）。

**日志为什么要截断**：llama-server 一直跑，日志无上限，全留在 React state 里会一直涨内存，
每次渲染还要遍历整个数组 —— 界面上限是 `LOG_LIMIT = 3000`（`useLauncher.ts:25-26`，
注释里写明「主进程侧另有一份 4000 条的缓冲，用于失败诊断」）。主进程那份的上限是
`LOG_BUFFER_LIMIT`（`src/main/session.ts:66`），裁剪在 `:609-611`：
`this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_LIMIT);`。

状态的「合并」是必要的：主进程推来的 `StatePush` 只有 `state` / `note` / `health`
（`src/shared/ipc.ts:253-257`），而界面要的 `StatusPayload` 还带 `pid` / `baseUrl` / `lastCommand`
（`src/shared/ipc.ts:233-242`）；它**没有覆盖 `health`** —— 健康检查由轮询和 `api.status()` 负责。

订阅函数来自 preload，返回的就是清理函数（`src/preload/index.ts:61-67`）。**为什么必须调用**：
`useLauncher.ts:299-304` 的 effect 返回里依次做 `disposed = true` → `offLog()` → `offState()` →
`offMetrics()` → `void api.metricsWatch(false)`，注释写着「卸载时务必关掉采样，否则会一直每秒钟
起一个 nvidia-smi 进程」。漏了 `offLog()`：`ipcRenderer.on` 的监听器还在，组件重挂时又注册一个 ——
开发模式 StrictMode 会把 effect 跑两次，于是每来一行日志你看到两行，再重挂变三行，而且是永久性的。

### 3.6 另外两条 effect：防抖重拼 & 运行时轮询

```ts
// src/renderer/src/hooks/useLauncher.ts:315-319
  // ---- 配置变化 → 防抖后重拼命令行 ----
  // busy 不为空时（正在启动/停止/保存）先不重拼：那期间配置本来就不会变，
  // 少发一次 IPC，也避免与启动流程抢时序。
  useEffect(() => {
    if (api === null || config === null || busy !== null) return;
```

这个 effect 的延迟是 `PREVIEW_DEBOUNCE_MS = 350`（`useLauncher.ts:27-28`），里面调 `api.preview(config)`
并按 `isErrorPayload(result)` 分支写 `setPreview` / `setPreviewError`（`:321-334`）；收尾是
`return () => clearTimeout(handle);`（`:335`）—— **那才是防抖的关键**：每次 `config` 变化先取消上一次的
定时器；只有 `setTimeout` 没有 `clearTimeout` 就只是「延迟发一次」。

轮询那条（`useLauncher.ts:342-347`）先判 `if (api === null || status?.running !== true) return;`，
再 `setInterval(() => { void api.status().then(setStatus).catch(() => undefined); }, STATUS_POLL_MS)`，
收尾 `clearInterval(handle)`，依赖 `[api, status?.running]`。

`STATUS_POLL_MS = 2000`（`useLauncher.ts:29-30`）。依赖里放的是 `status?.running` 这个**布尔值**
而不是整个 `status` 对象 —— 否则每次轮询回来 `status` 换了新对象，effect 会重启 `setInterval`，
变成「每 2 秒重建一次定时器」。轮询失败被 `.catch(() => undefined)` 静默吞掉，
理由见 `:339-340`：一次抖动不该在界面上弹错误。

### 3.7 `App.tsx`：只做布局与标签页

`App.tsx` 自己的 state 只有一个 `tab`（`:26`），唯一的逻辑是「启动失败自动切到日志页」（`:29-31`）。
然后就是**把整个 `launcher` 往下传** —— 所有组件的 props 类型都是同一个 `{ launcher: LauncherController }`
（`App.tsx:99-102`）。这是有意为之的取舍：省掉 props 层层拆包，代价是组件与 Hook 耦合更紧。

标签页是**条件渲染**而不是渲染完再隐藏；`App.tsx:138` 那条注释是理解 `MetricsPanel` 的钥匙：
「监控页自己管采样的开关（挂载开、卸载关），所以只在激活时渲染」（`:139` 是那行渲染）。
它的「局部状态」不是 `useState`，而是 `useEffect(() => { watchMetrics(true);
return () => watchMetrics(false); }, [watchMetrics])`（`MetricsPanel.tsx:145-148`）。
`watchMetrics(true)` 会顺手先拉一次快照，免得面板空等一秒（`useLauncher.ts:577-586`）。

**纯展示组件**：`TopBar`、`StatusBar`、`DecisionTable`、`CommandBar`（除一个 `copied` 临时态）。
**自己持局部状态的**：`ParamsForm`（折叠）、`LogPane`（过滤 / 等级 / 自动滚动）、
`CommandBar`（`copied`）、`ModelPanel`（新档案名输入框）、`MetricsPanel`（采样生命周期）。

### 3.8 `ParamsForm`：由 schema 驱动整张表单

整表由 `schema` 生成而不是手写 JSX，理由在 `ParamsForm.tsx:155-157`：「llama.cpp 有一百多个参数
且改名频繁，手写必然跟不上；这里只负责"怎么展示"」。`kind` → 控件的映射是 `controlFor()`
（`:44-86`），判定顺序不能乱（`:29` 解释了 enum 判断要排在 `kind` 前：它的 `kind` 可能是 `string`）：

```tsx
// src/renderer/src/components/ParamsForm.tsx:50-60
  if (entry.kind === "bool") {
    return <Toggle checked={value === true} onChange={set} disabled={disabled} />;
  }

  if (entry.enumValues !== undefined && entry.enumValues.length > 0) {
    return (
      <Select
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(next) => set(next === "" ? null : next)}
        options={[{ value: "", label: "（用 llama.cpp 默认）" }, ...entry.enumValues.map((v) => ({ value: v, label: v }))]}
      />
    );
  }
```

`int` / `float` → `NumberInput`（步长 `entry.kind === "float" ? 0.05 : 1`，`:65-75`）；其余 → `TextInput`
（`:77-85`）。贯穿全表单的约定是**清空 = 不传 = 写回 `null`**（`ParamsForm.tsx:35-36`：
「清空输入表示"不传这个参数"，一律写回 `null`（而不是空串）——拼装层靠"值为 null/空串"来决定跳过，
用空串容易在别处被当成有效值」），所以 `Select` / `TextInput` 回调里都有 `set(next === "" ? null : next)`。

**徽标**在 `Badges()` 里组装（`ParamsForm.tsx:103-150`），对应 `SchemaEntry`（`src/shared/ipc.ts:73-90`）：

| 徽标 | 判定条件 | 颜色 | 含义 |
| --- | --- | --- | --- |
| `本版本不支持` | `entry.supported === false` | rose | 当前 `--help` 里没这个参数名，控件一并置灰 |
| `未探测` | `entry.supported === null` | slate | 还没跑过 `--help` |
| `已废弃` | `entry.deprecated` | amber | 命中的参数在 help 里被标了 `DEPRECATED` |
| `preset 接管` | `presetOwned && raw` 有值 | violet | 命令行不再传它，改由配置里的 `presets` 决定 |

`preset 接管` 的判定逐字是 `if (presetOwned && raw !== null && raw !== undefined && raw !== "")`
（`ParamsForm.tsx:132`）。它要额外判「有值」的理由在 `:95-96`：「**仅当该参数有值时才显示** ——
没配却提示"被 preset 接管"会让人误解」。数据来源是 `preview.preset.presetKeys`（`:170`）；
置灰来自 `const disabled = entry.supported === false;`（`:205`）。

**`MODEL_PANEL_KEYS` 为什么存在**：模型目录、主模型、预加载模型这些参数在「参数」页里只是纯文本框，
体验差；它们更适合左栏「模型」面板那种「浏览… / 下拉框」形态。但同一个字段只能有一处渲染：

```tsx
// src/renderer/src/components/ParamsForm.tsx:12-25
 * 必须共享同一份清单：否则同一个字段会在两处渲染，改动不同步时
 * 会出现"左边显示 A、右边显示 B"的假象。`App` 里的参数计数也用它来对齐。
 */
export const MODEL_PANEL_KEYS: ReadonlySet<string> = new Set([
  "llama_dir",
  "main_model",
  "models_dir",
  "models_preset",
  "models_max",
  "preload_model",
  "vision_model",
  "draft_model",
]);
```

**标签页计数也要跟着减**，就是注释里「`App` 里的参数计数也用它来对齐」那句（`App.tsx:58-59`：
`(launcher.schema?.entries ?? []).filter((entry) => !MODEL_PANEL_KEYS.has(entry.key)).length`）。
不减的话，标签上写「参数 57」、进去只数出 49 个，用户会以为少渲染了；`ParamsForm.tsx:174` 用同一份
清单跳过（`if (MODEL_PANEL_KEYS.has(entry.key)) continue;`）。

### 3.9 `DecisionTable` 与 `LogPane`

决策表每行的语义由 `reason` 决定，颜色由映射表决定：

```tsx
// src/renderer/src/components/DecisionTable.tsx:5-16
const REASON_TONE: Record<string, Tone> = {
  cli: "emerald",
  "preload-override": "violet",
  "preset-owned": "amber",
  unsupported: "rose",
  fallback: "amber",
  skipped: "slate",
  unset: "slate",
};

/** 这些原因代表"参数确实被传进去了" */
const EMITTED = new Set(["cli", "preload-override", "fallback"]);
```

这七种原因和 `src/core/args.ts:83-91` 的 `REASON_LABEL` 一一对应，但**文案不是渲染层写的**：
原因文案用 `{step.reasonLabel}`（`DecisionTable.tsx:60`），分组徽标用
`preview.steps.find((step) => step.reason === reason)?.reasonLabel ?? reason`（`:42`）；
`argvText` 也是主进程格式化好的。理由在 `src/core/args.ts:96-97`：「GUI 是通过 IPC 拿数据的、
CLI 是直接调用的，所以文案统一由这里提供……避免两边各写一份后漂移」。
「实际传入」那一列空的时候显示一个灰色的 `—`（`DecisionTable.tsx:63-65`），
这样「真的没有」和「渲染崩了」能区分开。

`LogPane` 的着色是**两级优先**：先看 `kind`（个别事件更醒目），没有特殊 `kind` 才回落到 `level`：

```tsx
// src/renderer/src/components/LogPane.tsx:14-22
/** 个别事件值得用更醒目的颜色，优先于等级配色 */
const KIND_TEXT: Partial<Record<LogEventKind, string>> = {
  oom: "bg-rose-950/50 text-rose-200",
  listening: "text-emerald-300",
  "model-loaded": "text-cyan-300",
  "model-list": "text-cyan-300/80",
  perf: "text-violet-300",
  error: "text-rose-300",
};
```

用法就是一行 `??`（`LogPane.tsx:99`）：`${KIND_TEXT[entry.kind] ?? LEVEL_TEXT[entry.level]}`，
`LEVEL_TEXT` 在 `:8-12`。每行的 key 用 `entry.seq`（`:97`）—— 主进程给的递增序号
（`src/shared/ipc.ts:244-251`），比数组下标可靠。

渲染层还有**第二道截断** `RENDER_LIMIT = 1500`（`LogPane.tsx:24`），对**过滤之后**的结果再裁一次
（`:38`：`kept.length > RENDER_LIMIT ? kept.slice(kept.length - RENDER_LIMIT) : kept`）。
两个上限看着重复，但筛掉的行和留下的行没有固定比例；`useMemo`（`:33`）也是必要的，
否则「自动滚动」那个 effect 每渲染一次都会以为数据变了。自动滚到底就一行命令式代码（`:43`）：
`if (box !== null && autoScroll) box.scrollTop = box.scrollHeight;` ——
没有用 `scrollIntoView`，而是把容器的 `scrollTop` 设成 `scrollHeight`。

### 3.10 UI 自检钩子：`installUiExport`

**它是什么**：主进程里一个默认不生效的函数，读环境变量 `LLAMA_LAUNCHER_UI_DUMP`；
设了就在界面加载完后导出文本 + 截图，然后退出应用 —— 一套「自动化截图测试」。

它挂载的位置不能错：`installUiExport(win)`（`index.ts:314`）必须在 `loadURL` / `loadFile`
（`:316-321`）**之前**调用，理由在 `:312-313` 的注释：「监听必须挂在 load 之前：`await loadFile()`
是在 `did-finish-load` 之后才 resolve 的，挂晚了就永远等不到事件（实测会一直不退出）」。

对正常启动零副作用：读不到 `process.env["LLAMA_LAUNCHER_UI_DUMP"]` 就 `return`（`:339-340`），
之后才 `target.webContents.once("did-finish-load", ...)`（`:342`）—— `once` 而不是 `on`，
因为只抓一次；里面的 `setTimeout` 是等首次渲染 + 自动探测跑完：

```ts
// src/main/index.ts:333-334
 * 执行顺序：等 3.5s（首次渲染 + 自动探测都要时间）→ 可选执行一段 JS → 导出文本与截图
 * → **无论成败都退出应用**（`finally` 里 `app.quit()`），保证无人值守时不会挂住。
```

**导出两样东西。** 第一样是人眼看到的文本；第二样是从 DOM 里按选择器抓的结构化摘要
（`index.ts:355-364`，`executeJavaScript` 里 `JSON.stringify` 之后返回）：

```ts
// src/main/index.ts:356-358
          const structured: unknown = await target.webContents.executeJavaScript(`(() => {
            const tabs = [...document.querySelectorAll("nav button")].map((b) => b.textContent.replace(/\\s+/g, " ").trim());
            const groups = [...document.querySelectorAll("main section > button")].map((b) => b.innerText.replace(/\\s+/g, " ").trim());
```

这些选择器正好对应前面读过的组件：`nav button` 是标签页（`App.tsx:117-131`），
`main section > button` 是参数分组头（`ParamsForm.tsx:189-198`），
`table tbody tr` 是决策表的行（`DecisionTable.tsx:57`），`aside input, aside select` 是左栏
「模型」面板的字段（`ModelPanel.tsx:134` 的 `<aside>`）。最后写文件、截图，**无论成败都退出**：
`capturePage()` + `writeFileSync(...)`（`:366-367`），`catch` 里往同一个 `.txt` 写「导出失败：…」（`:369`），
`finally` 里 `app.quit()`（`:371`）。三个细节：截图用 `capturePage()` 而不是拍屏幕（`:331` 的理由是
「截的是渲染内容本身，不受窗口是否被遮挡影响」，而窗口是 `show: false` 建的，`:288-289`）；
失败也写文件，这样「脚本挂了」和「脚本没跑」能区分；`finally` 里退出，否则命令会永久挂住。

**怎么用它**（`README.md:276-281`，原文照抄）：

```powershell
$env:LLAMA_LAUNCHER_UI_DUMP='E:\Code\llama\llama-launcher\out\ui'   # 写出 ui.txt（界面真实文本）+ ui.png（capturePage 截图）
$env:LLAMA_LAUNCHER_UI_EXEC='...一段 JS...'                          # 可选：先执行一段 JS（例如点一下「启动服务」）
$env:LLAMA_LAUNCHER_UI_EXEC_WAIT='15000'                             # 执行后等多久再截图
pnpm build; node_modules\.bin\electron .
```

`LLAMA_LAUNCHER_UI_EXEC` 对应 `index.ts:347-353`：先 `executeJavaScript(script)`，
再等 `LLAMA_LAUNCHER_UI_EXEC_WAIT`（默认 9000 ms）才截图。它验证了什么，`README.md:283-284` 有实测结论：

> 这条路径被用来验证「点启动 → IPC → 拼命令行 → spawn → 日志推回界面 → 状态栏变化」整条链路，
> 导出的 `ui.txt` 里能直接读到 StatusBar 的 `running / PID / 服务就绪` 和日志面板的全部行。

**为什么必须先 `pnpm build`**：主进程加载的是**构建产物**。`package.json:9` 写着
`"main": "out/main/index.js"`；`rendererHtml` 指向 `../renderer/index.html`（`index.ts:38`），
electron-vite 把三段分别产出到 `out/main`、`out/preload`、`out/renderer`（`electron.vite.config.ts:27`、
`:38`、`:50`）。开发模式的 `ELECTRON_RENDERER_URL` 由 Vite dev server 注入，你手动跑 `electron .`
时它不存在（`index.ts:316-321` 的分支），走的一定是 `out/renderer/index.html`。
所以**改了源码却没 `pnpm build`，导出的 `ui.txt` 描述的是上一次构建的界面** —— 最坏的情况是它
「验证成功」了一个已经被你改坏的行为。这是所有快照测试类工具的通用陷阱：**被测量的是产物，不是源码。**

> **关于「为什么要往 DOM 里塞 `<pre>` 再导出」**：**本项目没有用 `<pre>`。** `installUiExport`
> 走的是两条 `executeJavaScript` —— 一条取 `document.body.innerText`（`index.ts:355`），一条在页面里
> `JSON.stringify` 后返回字符串（`:363`）。`executeJavaScript` 的返回值要跨进程做结构化克隆，
> DOM 节点这类东西过不去，所以**在页面里先把结果压成字符串**再返回。
> `document.createElement("pre")` 那套是同一需求的另一种解法，本项目里没有对应代码可引用 ——
> 想展开请自己动手验证，不要照抄这段描述。

## 4. 踩过的坑与设计取舍

### 4.1 「点了按钮像没反应」

> 「打开配置 / 保存 / 另存为 / 重新探测 / 导入 presets.ini」这些操作**成功时不一定改变界面上的任何东西**
> —— 重新探测同一份 llama.cpp 得到的参数表与上次完全一样，保存没有告警时提醒区也不动。
> 于是用户会以为按钮坏了（实测过：探测确实跑了 370 ms，但状态栏与顶栏文案一字未变）。
>
> —— `README.md:56-58`

（`useLauncher.ts:375` 的注释里记的是「367ms」，两次实测都留着。）解决方案就是 3.4 的三件套。

### 4.2 状态整体替换，而不是逐字段更新

> 之所以整体替换而不是逐个 setState：这些载荷代表"换了一份配置"，
> 逐字段更新容易出现"配置换了但参数表还是旧的"这种不一致。
>
> —— `useLauncher.ts:171-173`

### 4.3 `metricsWatch(false)` 在卸载时必须调

> 卸载时务必关掉采样，否则会一直每秒钟起一个 nvidia-smi 进程
>
> —— `useLauncher.ts:303`

配合 `App.tsx:138` 的「只在激活时渲染」构成闭环：`App` 负责挂载 / 卸载，`MetricsPanel` 负责开关，
`useLauncher` 负责清理兜底。

### 4.4 折叠状态不进配置

> 折叠状态是纯界面状态（`collapsed`），不进配置，所以不参与"配置变化 → 重拼命令行"。
>
> —— `ParamsForm.tsx:159`

判断标准很干脆：**这个状态会影响命令行吗？** 不会就留在组件里。

### 4.5 界面层的构建坑

> 1. **`electron` 必须显式列进 rollup 的 `external`。** ……结果应用一启动就报
>    `Electron failed to install correctly`（调用栈里能看到 `default_app.asar`）。
> 2. **`did-finish-load` 监听必须在 `loadFile()/loadURL()` 之前挂。**
>
> —— `README.md:264-270`

第 2 条直接关系到 3.10：挂晚了的症状是**进程不退出**，不是报错。这类「静默失效」最难查。

## 5. 动手练习

### 练习 1（易）：给「清空日志」加一条反馈

**任务**：`clearLogs()` 现在是 `useCallback(() => setLogs([]), [])`（`useLauncher.ts:565`），
清空后界面没有任何提示。请让它清空成功后走一次 `flash`。

**提示**：照 `save`（`useLauncher.ts:458-471`）或 `openConfig`（`:487-498`）的写法调 `flashMessage(...)`
（定义在 `:212`），并把它加进 `clearLogs` 的依赖数组，否则拿到的是旧闭包。

**验收标准**：点「清空」后顶栏下方出现一条天蓝色「完成」横幅，6 秒后自动消失，点「知道了」能立刻关掉；
`pnpm typecheck` 为 0 错。

### 练习 2（中）：让参数表单能按关键字过滤

**任务**：`ParamsForm` 现在只能按分组折叠。加一个顶部搜索框，只显示 `label` 或 `resolvedFlag`
含该关键字的行。

**提示**：局部状态照 `LogPane.tsx:28` 的 `filter` 写（`useState("")`），**不要放进 `config`**（理由见 4.4）；
输入框用 `TextInput`（`ui.tsx:89-117`）；过滤加在 `ParamsForm.tsx:173-178` 那个 `byGroup` 循环里
（过滤后为空的分组会被 `:184` 的 `if (entries.length === 0) return null;` 自动跳过）；
大小写不敏感参考 `LogPane.tsx:34`。

**验收标准**：输入关键字后只显示匹配的行，清空后恢复全部且分组折叠状态没被重置；
搜索时命令行栏里的命令**一个字都不变**（证明你没把过滤条件写进 `config`）；`pnpm typecheck` 为 0 错。

### 练习 3（难）：用自检钩子证明你的改动真的生效了

**任务**：用 `installUiExport` 导出「参数」页的真实渲染结果，在 `ui.txt` 里证明练习 2 的搜索框
确实渲染出来了。

**提示**：先 `pnpm build`（**必须的**，理由见 3.10）；按 `README.md:266-271` 的三段环境变量来，
导出路径写 `E:\Code\llama\llama-launcher\out\ui`；想在截图前操作界面就用 `LLAMA_LAUNCHER_UI_EXEC`
传一段 JS（选择器写法参考 `index.ts:357`）；别忘了 `LLAMA_LAUNCHER_UI_EXEC_WAIT`。

**验收标准**：`out/ui.txt` 的「界面渲染文本」段里能看到你的搜索框 `placeholder` 文案，
`out/ui.png` 不是空白；命令跑完**进程自己退出了**；把改动注释掉、重新 `pnpm build` 再跑一次，
`ui.txt` 里那段文案应该消失 —— **不做这一步，你只证明了「导出能跑」，没有证明「导出反映的是你的改动」。**

## 6. 自测题

**第 1 题**：为什么 `onLog` 的 `setLogs` 里用 `prev.slice(prev.length - LOG_LIMIT + 1)` 而不是 `prev.slice(-LOG_LIMIT)`？

<details>
<summary>第 1 题答案</summary>

因为紧跟着还有 `next.push(entry)`（`useLauncher.ts:288`）。这段代码要保证的是「加上这一行之后
总数不超过 `LOG_LIMIT`」：先裁到 `LOG_LIMIT - 1` 条再 push，正好 `LOG_LIMIT` 条。写成
`prev.slice(-LOG_LIMIT)` 再 push 就会稳定超出上限一行 —— 边界差一，日志量大时就是内存慢慢涨的来源。
另外这个 `setLogs` 用的是**函数式更新**，因为日志是高频 push 的，用 `logs.length` 这样的闭包变量
会读到过期的值。

</details>

**第 2 题**：`useLauncher.ts:344` 的轮询失败被 `.catch(() => undefined)` 吞掉了。为什么不 `setError`？

<details>
<summary>第 2 题答案</summary>

注释写明了（`:339-340`）：「轮询失败被静默忽略（下一次轮询会再试，不必因为一次抖动就在界面上弹错误）」。
轮询是每 2 秒一次的后台行为，用户没有主动触发它；一次 IPC 抖动就弹一条要手动关的红色横幅是噪音，
而且 `error` 会一直挂着直到点「知道了」，多次失败还会互相覆盖。
**只有用户主动触发的动作失败才走 `error`** —— 那是 `run()` 那条路径的职责。

</details>

**第 3 题**：`MetricsPanel` 用条件渲染而不是 CSS 隐藏。改成 CSS 隐藏会发生什么？

<details>
<summary>第 3 题答案</summary>

组件永远不会卸载，`MetricsPanel.tsx:145-148` 那个 effect 的清理函数（`return () => watchMetrics(false)`）
就永远不会执行 —— **即使你切到「日志」页，主进程仍然每秒起一个 `nvidia-smi` 进程在采样**。
`useLauncher.ts:303-304` 那句 `api.metricsWatch(false)` 是兜底，但它只在**整个窗口卸载**时跑，
切标签页不会触发。所以这里是「必须条件渲染」，不是风格偏好。

</details>

**第 4 题**：徽标 `preset 接管` 为什么要求 `raw` 有值才显示？

<details>
<summary>第 4 题答案</summary>

`ParamsForm.tsx:95-96` 给的理由是：「没配却提示"被 preset 接管"会让人误解」。
这个徽标的含义是「命令行不会再传它，改由配置里的 `presets` 决定」—— 如果一个参数本来就没配值，
那么「命令行不传它」是**因为没值**，而不是因为被 preset 接管了。把两种不同的原因显示成同一个徽标，
会让用户去配置里找一条根本不存在的 preset 定义。判定代码在 `ParamsForm.tsx:132`。

</details>

**第 5 题**：为什么自检脚本要在页面里 `JSON.stringify(...)` 之后再返回，而不是直接返回对象？

<details>
<summary>第 5 题答案</summary>

`executeJavaScript` 的返回值要跨进程做结构化克隆，**DOM 节点、函数这类东西不可克隆**，
只有普通对象 / 数组 / 原始值能过。脚本里那些 `document.querySelectorAll(...)`（`index.ts:357-362`）
拿到的是节点列表，必须先在页面里转成字符串；而且结果在文件里就是格式良好的文本，
`writeFileSync` 时直接拼进去就行，还绕开了「某个字段带了不可克隆的值导致整次调用被拒」的风险。
`document.body.innerText`（`:355`）是同一思路的另一个应用：**把不可传的东西压成字符串**。

</details>

## 下一章

界面点一次按钮，背后是前面八章所有东西的总和。下一章换个方向：
**这些东西怎么保证不出错、又怎么打成一个能双击的 exe** ——
[10 测试、打包与发布](./10-测试-打包与发布.md)。
