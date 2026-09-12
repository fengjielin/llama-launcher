# llama-launcher —— llama.cpp 启动器

桌面端 llama.cpp 启动器。分两层：

- **core（`src/core`）**：零依赖、可 CLI 驱动。配置 → 运行时参数探测 → presets 解析 → 命令行拼装 →
  进程生命周期 → 日志流 → 就绪判断 → 失败诊断。**不 import electron**，因此能被单测、被 CLI 直接驱动。
- **GUI（`src/main` + `src/preload` + `src/renderer`）**：Electron + React + Tailwind。界面只通过 IPC 拿数据，
  **从不自己拼命令行**，所以「界面上看到的命令」和「实际启动的命令」永远是同一条。

## 当前进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **M1** | core：schema / 探测 / 拼装 / presets / 配置 / 进程 / 日志 / 健康检查 / CLI / 单测 | ✅ 已实跑 llama-server 验证 |
| **M2** | Electron + React + Tailwind 界面：模型选择、schema 驱动表单、启停、日志、决策表 | ✅ 已完成，已实跑「界面点启动 → 日志回流」全流程验证 |
| **M3** | 资源监控（VRAM/温度/功耗/曲线）、托盘常驻、多套配置档案、开机自启 | ✅ 已完成，已实跑真实 GPU 采集与档案落盘验证（共 109 项单测） |
| **M4** | 驱动/后端预检、打包分发 | 🚧 预检 ✅、免安装打包 ✅（已实跑打包产物）；单文件安装包受阻于 electron-builder 上游 bug，详见下文 |
| M5 | HF 镜像下载、多实例管理、`presets.ini` 可视化编辑 | 待开始 |

## 界面长什么样

```
┌───────────────────────────────────────────────────────────────────────────┐
│ llama.cpp 启动器  b10488  248 个参数   配置：…\llama-launcher.json  [按钮组] │
├──────────────────┬────────────────────────────────────────────────────────┤
│ [启动服务][打开网页]│ 实际启动命令  llama-server.exe --models-dir … -fa on …  │
│ 运行模式 (router)  │ ⚠ presets.ini 路径含非 ASCII…（自动拷到临时目录）        │
│ 模型（目录/预设/预加载/视觉/草稿）│ ┌ 参数 49 │ 决策表 52 │ 日志 24 ┐        │
│ llama.cpp（构建目录）│ │ 分组折叠的参数表单 / 决策表 / 实时日志（按等级着色） │
├──────────────────┴────────────────────────────────────────────────────────┤
│ running │ 端口已监听（等待 504 ms） PID 22064 │ http://127.0.0.1:8080 │ 服务就绪 │
└───────────────────────────────────────────────────────────────────────────┘
```

参数表单由 `schema.ts` **自动生成**，并按运行时 `--help` 探测结果显示三种徽标：
「preset 接管」（命令行不会再传，避免盖掉 presets.ini）、「已废弃」（如 `--mlock`）、「本版本不支持」（置灰）。

## 快速开始

### 桌面界面

```powershell
pnpm dev                 # 开发模式（Vite HMR + Electron）
pnpm build && pnpm start # 构建后运行（产物在 out/）
pnpm typecheck           # tsc --noEmit
```

### 命令行（core 不依赖界面，随时可用）

```powershell
cd E:\Code\llama\llama-launcher

# 1) 生成配置（自动探测 llama.cpp 目录、models 目录、presets.ini、预加载模型）
node src/cli.ts init --config llama-launcher.json

# 2) 只打印最终命令行 + 每个参数的决策原因（不启动任何进程，对拍用）
node src/cli.ts args --config llama-launcher.json

# 3) 现场探测 llama-server 的能力（版本、改名、不支持、已废弃）
node src/cli.ts probe --llama-dir E:\Code\llama\llama.cpp

# 4) 真正启动（流式打印日志、自动健康检查、失败给诊断、Ctrl+C 停止）
node src/cli.ts run --config llama-launcher.json

# 5) 把原版启动器（v1.9）的配置迁移过来
node src/cli.ts migrate --from "E:\Code\llama\llamaServer启动器\llama_launcher_config.json"
```

其它：`pnpm test` 跑测试；`node src/cli.ts init --help`… 见 `node src/cli.ts help`。

## 目录结构

```
llama-launcher/
├─ src/core/
│  ├─ types.ts         公共类型（全部是 Node 原生类型擦除可运行的写法）
│  ├─ schema.ts        ★ 声明式参数表：候选参数名 / preset 键 / 分组 / 说明
│  ├─ helpProbe.ts     ★ `--help` 解析 + 能力视图（参数改名的兜底机制）
│  ├─ args.ts          ★ 命令行拼装（纯函数）+ 参数决策表
│  ├─ presets.ts       presets.ini 解析（含非 ASCII 路径迁移）
│  ├─ config.ts        配置归一化 / v1.9 迁移 / llama.cpp 目录探测
│  ├─ launcher.ts      编排层：配置 → 探测 → presets → 命令行
│  ├─ llamaProcess.ts  进程状态机 / 日志泵 / taskkill 兜底
│  ├─ logLines.ts      行缓冲 / 日志分类 / 启动失败诊断
│  └─ health.ts        TCP 探测 / /health 语义 / 端口顺延
├─ src/cli.ts          命令行入口
├─ src/test/           单测（进程内运行，见下文"测试"）
└─ fixtures/           实测采集的真实数据（help / version / presets / 冒烟配置）
```

## 关键设计决策

1. **参数表是唯一真源**（`schema.ts`）
   GUI 表单、命令行拼装、preset 占位判断三者读同一张表。llama.cpp 参数改动频繁（本次实测就发现
   `--draft-type-k` → `--spec-draft-type-k`、`--model-draft` → `--spec-draft-model`、`--mlock` 被
   `--load-mode` 取代并标 DEPRECATED），把参数知识散进 UI 代码必然腐化。

2. **运行时探测，不硬编码版本判断**（`helpProbe.ts`）
   每个参数带一组候选名，`caps.pick()` 返回当前版本第一个支持的名字。所以启动器不需要"b10488 用什么、
   b10679 用什么"的分支表。

3. **参数决策表**（`args.ts` 的 `BuildStep[]`）
   每个参数都记录「传了没有 / 为什么」，理由有七种：命令行直传、预加载直传、preset 接管、版本不支持、
   兼容回退、按规则跳过、未配置。GUI 直接渲染这张表，用户就不会再问"我明明配了为什么没生效"。

4. **preset 与命令行的优先级如实处理**
   实测命令行优先级高于 presets.ini，所以 preset 里定义过的键命令行**不能再传**，否则会盖掉 preset。
   例外：预加载的模型不吃 preset（实测 ctx 被忽略、fit 会把 ctx 压到 4096），此时必须反过来由命令行直传 ——
   这条规则用 `preloadBypass` 标在具体参数上，与既有 PS1 脚本逐项对齐。

5. **`--models-preset` 的路径必须是 ASCII**
   中文路径会让 llama-server 刷两行日志后直接崩退。`stagePresetIfNonAscii()` 会先拷到临时目录再传，
   并在决策表里说明。

6. **行缓冲必须自己做**（`LineSplitter`）
   `child_process` 的 stdout 按块给，块边界会把一行切成两半。不缓冲，日志面板里会随机出现半行。

7. **`-fa` 的两种语法都支持**
   新版是 `-fa on/off/auto`，旧版是纯开关，按 `--help` 的占位符形式自动选，不猜。

8. **不静默降级**
   没有 `--fit-target` 时回退 `-ngl 99`（全量 offload）并明确告警，绝不悄悄变成纯 CPU 推理。

9. **日志分类优先用结构化等级**
   b10488 的日志形如 `0.00.146.987 W srv  llama_server: ...`，等级字母比关键词可靠
   （`CORS is set to allow all origins` 这种不含 warn 字样的告警只能靠它识别）。

## 验收标准

**同一份配置，`args` 输出的命令行必须与既有 `llama-oneclick.ps1` 生成的逐项一致。**
`src/test/args.test.ts` 里的黄金用例就是这个基准。有意偏离的三处记在下面「已知偏离」。

## 测试

```powershell
pnpm test          # 等价于 node src/test/run-tests.ts
```

148 项测试覆盖：`--help` 解析（真实 fixture）、能力回退、preset 并集/单模型/非 ASCII/BOM、命令行拼装黄金用例、
预加载覆盖规则、旧版本各回退分支、参数改名、配置迁移、上下文单位识别、行缓冲跨块、日志分类、失败诊断、
`/health` 的 200/503 语义、端口顺延、GPU 采集解析（真实 `nvidia-smi` 输出）、CPU 差分、指标环形缓冲与序列化、
档案 CRUD 与文件名安全化、PE 导入表解析（真实 `ggml-cuda.dll`）、环境自检各判定分支、数据落点的三种情形。

> 为什么不用 `node --test`：那个运行器会为每个测试文件 spawn 子进程并把 stdio 接管道，在受限沙箱里直接
> `EPERM`。`run-tests.ts` 改成在同一进程里 import 全部测试文件，`node:test` 照样自动执行并设置退出码 ——
> 不需要任何测试框架，也不需要额外依赖。

**core 零依赖**：只用 Node 内置模块 + Node 22.18+ 的原生 TypeScript 类型擦除，没有构建步骤。
（想要类型检查再装 `typescript` + `@types/node`，然后 `pnpm typecheck`。）

## 实测记录

对 `E:\Code\llama\llama.cpp`（b10488，CUDA 12.4）实跑结果：

```
[状态] starting - 正在启动 llama-server.exe
0.00.145.948 I srv   load_models: Loaded 0 cached model presets
0.00.146.488 I srv   load_models: Loaded 5 local model presets from E:/Code/llama/models
0.00.146.767 I srv    operator(): Available models (5) (*: custom preset)
0.00.149.953 I srv  llama_server: listening on http://127.0.0.1:8099
[状态] running - 端口已监听（等待 501 ms）
服务已就绪：http://127.0.0.1:8099
[状态] stopping / exited - 已停止
```

顺带纠正两处旧认知（都是实测得出的）：

1. **router 模式且未加载模型时，`/health` 实测返回 200**（不是 503）。`fetchHealth()` 两种都处理：
   200 = ready，503 = loading（服务在、模型未加载），连接被拒 = 还没监听。
2. **`presets.ini` 的 `[defaults]` 段不会被 llama-server 忽略**，它会被当成一个名叫 `defaults` 的模型：

   ```
   修复前： Loaded 6 custom model presets / Available models (6)   ← 多出一行 "* defaults"
   修复后： Loaded 5 custom model presets / Available models (5)   ← [defaults] 已被剔除
   ```

   后果是网页下拉框里多一个假模型、并白占一个 `--models-max` 槽位。现在启动器读配置仍从原文件读
   （`[defaults]` 是启动器自己的约定），但传给 llama-server 的那份会把这些段剔掉，并在提醒里说明。

## Windows 编码踩坑（自己排查时别被骗）

- 本机 PowerShell 是 **Windows PowerShell 5.1**：`Get-Content` 默认按 **GBK/ANSI** 解码，
  于是 `llama-launcher.json` 里的中文路径会**显示**成乱码（`涓€閿惎鍔ㄨ剼鏈?`），但文件本身是好的 ——
  用 `node -e "console.log(require('fs').existsSync(...))"` 这类纯 ASCII 输出来判断，别信控制台。
- 同一份 PS 5.1 的 `Set-Content -Encoding UTF8` 会**写入 BOM**。这正是本项目第一版 help fixture 带 BOM
  的原因（已修掉），也提醒你：**presets.ini 一旦被这样写过就会带 BOM，llama-server 会直接解析失败**。
  启动器写文件一律用 Node 的 `utf8`（无 BOM），并有单测守着这一点。
- 想验证时别用 `... | Select-Object -First N`：它会提前掐断上游管道，让 node 进程被中止，看起来像"启动失败"。
  用 `Where-Object { $_ -match '...' }` 过滤。

## 界面层的两个“必须这么写”的坑（实测踩过）

1. **`electron` 必须显式列进 rollup 的 `external`。**
   `electron-vite` 的 `externalizeDepsPlugin()` 只外部化 `package.json` 的 `dependencies`，而 `electron`
   装在 `devDependencies` 里 —— 不外部化的话 rollup 会把 electron 这个 **npm 包**整个打进主进程 bundle，
   而那个包的 `index.js` 在加载时会去解析自己的二进制路径、找不到就现场下载，结果应用一启动就报
   `Electron failed to install correctly`（调用栈里能看到 `default_app.asar`）。
2. **`did-finish-load` 监听必须在 `loadFile()/loadURL()` 之前挂。**
   `await loadFile()` 是在该事件之后才 resolve 的，挂晚了就永远等不到，进程也不会退出。

### 无人值守的界面自检

不想靠人盯着屏幕看，可以设两个环境变量让界面自己导出结果：

```powershell
$env:LLAMA_LAUNCHER_UI_DUMP='E:\Code\llama\llama-launcher\out\ui'   # 写出 ui.txt（界面真实文本）+ ui.png（capturePage 截图）
$env:LLAMA_LAUNCHER_UI_EXEC='...一段 JS...'                          # 可选：先执行一段 JS（例如点一下「启动服务」）
$env:LLAMA_LAUNCHER_UI_EXEC_WAIT='15000'                             # 执行后等多久再截图
pnpm build; node_modules\.bin\electron .
```

这条路径被用来验证「点启动 → IPC → 拼命令行 → spawn → 日志推回界面 → 状态栏变化」整条链路，
导出的 `ui.txt` 里能直接读到 StatusBar 的 `running / PID / 服务就绪` 和日志面板的全部行。

## 与既有资产的关系

| 资产 | 本项目如何使用 |
| --- | --- |
| `一键启动脚本\llama-oneclick.ps1` | 作为**行为基准与参数知识来源**：显存档位、`--help` 探测、preset 占位规则、各版本回退、踩坑注释全部继承 |
| `一键启动脚本\presets.ini` | 直接读取（fixtures 里有一份副本用于测试）；`[defaults]` 的 `; default-model =` 约定继续生效 |
| `llamaServer启动器\反编译输出\` | 仅作**功能需求参考**（v1.9 的配置字段、UI 分区、GPU 监控方式）。版权归原作者（bilibili:hsxbxq），**不复制其代码、样式与文案、不二次分发** |
| `llamaServer启动器\llama_launcher_config.json` | 用 `migrate` 子命令迁移字段并保留未知键 |

## 已知偏离与待确认

1. **思考开关**：新版本优先用 `--reasoning on/off/auto`（比 PS1 的 `--reasoning-budget 0` + 环境变量更直接），
   旧版本才回退到 PS1 那套双管齐下。
2. **`context: 64` 的单位**：v1.9 配置里写 64，按「K」解释成 65536 tokens（16G 档在 PS1 里是 32768，
   64 不可能是 token 数）。迁移时会**明确告警**，不静默改数。若你原本就想要 64 tokens，改成 `65536` 之外的值并加 `"contextUnit": "tokens"`。
3. **`presets.ini` 里那行 `; default-model = Qwen3.8-27B-Uncensored-IQ4_XS` 是注释，但 PS1 的读取逻辑仍然认它** ——
   也就是说你现在的脚本**每次启动都会预加载 27B 模型**。`init` 会把这个行为如实写进配置的 `preload_model`。
   不想要预加载就把 `preload_model` 置空（GUI 里会是个开关）。
4. **驱动与 dflash**：本机驱动 566.36，而 dflash/dspark/MTP 需要的开发版是 CUDA 13.3 构建
   （CUDA 13.x 需要 R580 以上驱动），现在跑不起来。M4 的「驱动/后端预检」会把这类问题在点启动前就报出来。
5. `--no-kv-offload` 这类旧参数不再单独建模，走「自定义参数」栏透传。
6. **`flash_attention` / `jinja` 的“关”要显式传值。** 这两个在 llama.cpp 里默认是**开启**的，
   做成界面开关后如果“关掉就什么都不传”，实际仍然开着 —— 所以现在会显式传 `-fa off` /
   `--no-jinja`；本版本没有对应形式时会在决策表里标「版本不支持」并告警，而不是假装关掉了。
7. **`-1` / `0` 一律视为“自动”不传**（`threads`、`parallel`），交给 llama.cpp 用物理核数自己定，
   比人肉猜准。

## M3：监控 / 托盘 / 档案 / 自启

### 资源监控（「监控」标签页）

| 指标 | 来源 | 说明 |
| --- | --- | --- |
| 显存占用 / 利用率 / 温度 / 功耗 / 频率 | `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` | 实测字段与单位见 `fixtures/nvidia-smi-query.txt` |
| CPU 占用 / 核心数 / 型号、内存 | Node 内置 `os` | CPU 占用靠两次采样差分算，首次采样显示 `N/A` 而不是谎报 0% |
| 推理吞吐（tok/s） | llama-server 日志里的 `eval time` / `prompt eval time` 行 | 顺带喂给采样器，形成随时间的曲线 |

设计要点：
- **按需采样**：只在打开「监控」页时每秒采一次，切走即停（历史保留）。每秒起一个
  `nvidia-smi` 进程是实打实的开销，没人看的时候不该烧。实测 300ms 那种频率会明显抬高 CPU。
- **`null` 不等于 0**：字段不可用时（笔记本的 `power.draw`、老驱动缺字段）返回 `null`，
  曲线遇到 `null` 会**断开**而不是画一条不存在的斜线。
- **没有 NVIDIA 卡也能用**：`nvidia-smi` 不可用时只在面板上提示，CPU/内存照常显示。
- 折线图是手写 SVG（`Sparkline`），零依赖 —— 这里只需要"一条随时间变化的线"。

### 托盘常驻

- 图标两态：灰点 = 服务没跑，绿点 = 在跑（base64 内嵌，避免打包时的资源路径问题）
- 右键菜单：显示/隐藏主窗口、启动服务、停止服务、打开网页、开机自启、关闭窗口时缩到托盘、退出
- **关闭窗口 != 退出**：默认「缩到托盘」，服务继续跑（这是启动器该有的行为）；
  真正退出走托盘菜单的「退出」——它会先停 llama-server 再退，不留占显存的孤儿进程
- 托盘创建失败**不影响程序启动**（会被 try/catch 包住并打错误日志），界面与 CLI 照常可用

### 配置档案

一个档案 = 档案目录下的一个 JSON 文件，内容就是一份完整配置。选这个最朴素的形式是因为
用户可以自己改、可以拷给别人、坏了也只坏一套。档案目录在配置文件同级的 `profiles/`（界面
上有「打开目录」按钮）。

- 档案名会被规整成安全文件名：非法字符替换、**目录穿越输入无效化**（有单测守着）
- 载入档案会把它**设为当前配置**，之后「保存」即写回该档案
- 坏掉的档案单独标记「⚠ 无法解析」，不影响其它档案
- `profiles/` 已加进 `.gitignore`（里面是本机路径）

### 开机自启

用 `app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] })`：自启时只驻留托盘不弹窗。
Windows 与 macOS 支持；Linux 需要安装 `.desktop` 项，暂未实现（界面上会说明并把开关置灰）。

> ⚠ 本次开发**没有实际打开**这个开关（那会写入系统登录项）。功能代码与界面都已就位，
> 想验证的话点一下开关，然后用 `Get-CimInstance Win32_StartupCommand` 或任务管理器的
> 「启动」页确认，关掉后会立刻移除。

## M4：环境自检 与 打包分发

### 环境自检（「自检」标签页）

回答的是「这份 llama.cpp 构建 + 这台机器配不配得上」，**全部判据都在本地，不联网**：

| 检查项 | 判据 |
| --- | --- |
| 这份构建需要哪个 CUDA | `ggml-cuda.dll` 的 **PE 导入表**：CUDA 12 构建链 `cudart64_12.dll`，CUDA 13 构建链 `..._13.dll` |
| 驱动能不能跑它 | `nvidia-smi` 头部的 `CUDA Version:`（驱动支持的 CUDA 上限） |
| CUDA 运行时在不在 | 按 exe 同目录 → PATH → System32 的顺序解析导入的那些 DLL |
| 后端构成 | 同目录下的 `ggml-*.dll`（cpu / cuda / vulkan / rpc …） |
| 模型能不能装下 | 模型文件体积 vs 显存总量（>85% 就警告：KV cache 放不下） |
| 模型文件是否完好 | 开头 4 字节是不是 `GGUF` 魔数（能抓出没下完的文件） |
| 端口 | TCP 探测 |

兼容规则是 CUDA 的官方规则：**同一大版本内向下兼容**（支持 12.7 的驱动能跑任何 12.x 构建），
跨大版本则要求驱动不低于构建所需的大版本。所以本机「驱动 566.36（支持 CUDA 12.7）+ b10488 CUDA 12.4 构建」
判定为**匹配**；只有当你换上 CUDA 13.x 的构建时才会明确报「驱动太旧」，并给出两条出路
（升级驱动到 580+，或换回 CUDA 12 的构建）——**不会推荐你去用开发版**。

几个刻意的设计：
- **只提示、不拦截**：自检误判的代价（把用户挡住）比漏判（多一条警告）大得多，启动不会被它阻断
- **结果按配置缓存**（exe / 模型 / 端口 / presets 路径为键），服务启停后会作废重算（端口占用状态变了）
- 自检本身**永不抛异常**：任何一步失败都退化成"该项信息缺失"，其余检查照常跑

### 打包分发

```powershell
pnpm package            # → dist/win-unpacked/ ：免安装目录，双击 llama-launcher.exe 即用
pnpm package:portable   # → 单文件便携版（当前受阻，见下）
```

产物里**只有启动器自己**（`out/` 三份产物 + `package.json`）：llama.cpp 与模型都留在外面 ——
它们是几十 GB 的东西，而且你本来就会换构建版本，打进去反而没法换。启动器启动时按配置去找
`llama-server.exe`。

### 数据放哪儿：便携优先

策略在 `src/main/paths.ts`（有单测覆盖三种情形）：

| 情形 | 配置 | Chromium 运行时数据 |
| --- | --- | --- |
| 开发模式（未打包） | 项目根目录 | Electron 默认 userData（不动它） |
| **打包后，exe 目录可写** | **`<exeDir>/llama-launcher.json`** | **`<exeDir>/data/`** |
| 打包后，exe 目录只读（如装进 `Program Files`） | `%APPDATA%\llama-launcher\` | 同左 |

也就是说：**便携模式下整个文件夹拷走就等于把配置与数据一起带走，`%APPDATA%` 里不留任何东西**
（实测：清空 `%APPDATA%\llama-launcher` 后跑一次打包产物，那个目录不会被再创建，而 exe 旁边
出现了 `llama-launcher.json` 与 `data/`）。首次运行时如果 exe 旁边还没有配置，会**自动生成一份默认配置**
（含自动探测到的 `llama.cpp` 目录），并留一条「已生成默认配置：<路径>」的提示。
界面左栏「启动器设置」里也把这三条路径直接显示出来。

> 踩过的坑：`app.getPath("userData")` **这个调用本身会把目录建出来**。
> 早先的写法在"决定落点"之前就调它取默认路径，结果便携模式下也在 `%APPDATA%` 里留了个空目录。
> 现在 `chooseDataLayout` 的 `defaultUserDataDir` 是**惰性求值**的（传函数），只在真要回退时才去问它。

**已实测**：打包出的 `llama-launcher.exe` 能独立运行，自己探测到 `E:\Code\llama\llama.cpp`，
自检面板正常显示「构建需要 CUDA 12 / 驱动支持 12.7 / RTX 4060 Ti」。

#### 打包时踩的三个坑（都写进 `electron-builder.yml` 注释了）

1. **electron-builder 26.x 有个上游 bug**：它的 `resolveCacheMode` 读 `@electron/get` 的
   `ElectronDownloadCacheMode`，但依赖范围写的是 `^3.0.0`，而 **3.0.0 并不导出该符号**（3.1.0 才导出），
   于是报 `Cannot read properties of undefined (reading 'ReadWrite')`。
   绕法：`electronDist: node_modules/electron/dist` —— 直接复用装好的 Electron 发行目录，不走那条下载路径。
2. **同一个 bug 也卡住安装包**：`portable` / `nsis` 目标要下载 7za、NSIS 工具链，走的还是那条坏路径，
   因此**单文件安装包目前打不出来**（`--dir` 免安装目录不受影响）。
   彻底的修法是把 `@electron/get` 提到 3.1.0 并让 `app-builder-lib` 用上它 ——
   已在 `package.json` 里装了 `@electron/get@3.1.0` 并加了 `pnpm.overrides`，但 pnpm 没把它应用到
   `app-builder-lib` 的那份嵌套副本上，还需要再想办法（`pnpm patch` 或清理 lockfile 重装）。
3. **图标给现成的 `.ico`**，不要让 electron-builder 从 PNG 转换（它的转换要调 app-builder 的二进制，本机报错）。
   `build/icon.ico` 是手写的：ICO 头 + 内嵌一张 256×256 PNG（Windows Vista+ 原生支持这种形式）。

> 环境相关提醒：如果在**受管沙箱**里跑打包，输出目录必须放在工作区之外
> （`--config.directories.output=<工作区外的路径>`），否则工作区的文件观察层会持有刚生成的文件，
> 让 electron-builder 的 unlink 报 `EBUSY`。在你自己的终端里没这个问题。

## 下一步（M5）

- **单文件安装包**：把上面第 2 条坑解决掉（让 `app-builder-lib` 用上 `@electron/get@3.1.0`），
  然后 `pnpm package:portable` 就能出便携版单 exe、`nsis` 目标能出安装程序
- **HF 镜像下载**：接 `hf-mirror`，带进度与断点续传；以及 `llama-quantize` / `gguf-split` 的图形化
- **`presets.ini` 可视化编辑**：在界面里增删改模型段，不必手写 ini
- **多实例管理**：同时跑多个 llama-server，各自分配端口与显卡

数据源与纯逻辑会继续留在 core 侧（可单测），界面只做展示。
