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
| **M4** | 驱动/后端预检、打包分发 | ✅ 预检 ✅；免安装目录与单文件便携版都已实跑验证（打包前规避 `.asar` 占用的入口是 `scripts/package.mjs`） |
| M5 | HF 镜像下载、多实例管理、预设可视化编辑 | 待开始 |

## 界面长什么样

```
┌───────────────────────────────────────────────────────────────────────────┐
│ llama.cpp 启动器  b10488  248 个参数   配置：…\llama-launcher.json  [按钮组] │
├──────────────────┬────────────────────────────────────────────────────────┤
│ [启动服务][打开网页]│ 实际启动命令  llama-server.exe --models-dir … -fa on …  │
│ 运行模式 (router)  │ ℹ 已为 5 个模型定义预设（在配置的 presets 里）              │
│ 模型（目录/预设/预加载/视觉/草稿）│ ┌ 参数 49 │ 决策表 52 │ 日志 24 ┐        │
│ llama.cpp（构建目录）│ │ 分组折叠的参数表单 / 决策表 / 实时日志（按等级着色） │
├──────────────────┴────────────────────────────────────────────────────────┤
│ running │ 端口已监听（等待 504 ms） PID 22064 │ http://127.0.0.1:8080 │ 服务就绪 │
└───────────────────────────────────────────────────────────────────────────┘
```

参数表单由 `schema.ts` **自动生成**，并按运行时 `--help` 探测结果显示三种徽标：
「preset 接管」（命令行不会再传，避免盖掉配置里的预设）、「已废弃」（如 `--mlock`）、「本版本不支持」（置灰）。

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

# 1) 生成配置（自动探测 llama.cpp 目录、models 目录、presets.ini、预加载模型；presets.ini 的内容会转成配置里的 presets）
node src/cli.ts init --config llama-launcher.json

# 2) 只打印最终命令行 + 每个参数的决策原因（不启动任何进程，对拍用）
node src/cli.ts args --config llama-launcher.json

# 3) 现场探测 llama-server 的能力（版本、改名、不支持、已废弃）
node src/cli.ts probe --llama-dir E:\Code\llama\llama.cpp

# 4) 真正启动（流式打印日志、自动健康检查、失败给诊断、Ctrl+C 停止）
node src/cli.ts run --config llama-launcher.json
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
│  ├─ presets.ts       模型预设：JSON 形态 ⇄ 渲染成 llama-server 的 ini（含旧 ini 的导入）
│  ├─ config.ts        配置归一化 / llama.cpp 目录探测
│  ├─ launcher.ts      编排层：配置 → 探测 → presets → 命令行
│  ├─ llamaProcess.ts  进程状态机 / 日志泵 / taskkill 兜底
│  ├─ logLines.ts      行缓冲 / 日志分类 / 启动失败诊断
│  └─ health.ts        TCP 探测 / /health 语义 / 端口顺延
├─ src/cli.ts          命令行入口
├─ src/test/           单测（进程内运行，见下文"测试"）
├─ scripts/package.mjs 打包入口：生成 .electron-dist 过滤镜像 + 输出目录兜底
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
   实测命令行优先级高于 preset，所以 preset 里定义过的键命令行**不能再传**，否则会盖掉 preset。
   例外：预加载的模型不吃 preset（实测 ctx 被忽略、fit 会把 ctx 压到 4096），此时必须反过来由命令行直传 ——
   这条规则用 `preloadBypass` 标在具体参数上，与既有 PS1 脚本逐项对齐。

5. **模型预设写成配置里的 JSON，ini 降级为"给服务器的中间产物"**
   预设直接存在配置的 `presets` 字段（模型名 → 参数表，键名沿用 llama.cpp 自己的
   `ctx-size` / `cache-type-k` / `fit-target` / `load-mode` / `threads`…），启动时渲染成临时 ini 再传路径。
   这么改顺带消掉了 ini 时代两个必踩的坑：中文路径会让 llama-server 崩退（每次都得转存到 `%TEMP%`）、
   `[defaults]` 段会被服务器当成一个假模型。现在那份 ini 是我们生成的：路径在 `%TEMP%`、段里只有真模型。
   详见下文「模型预设：写在配置里」。

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

170 项测试覆盖：`--help` 解析（真实 fixture）、能力回退、preset 并集/单模型/非 ASCII/BOM、命令行拼装黄金用例、
预加载覆盖规则、旧版本各回退分支、参数改名、配置迁移、上下文单位识别、行缓冲跨块、日志分类、失败诊断、
`/health` 的 200/503 语义、端口顺延、GPU 采集解析（真实 `nvidia-smi` 输出）、CPU 差分、指标环形缓冲与序列化、
档案 CRUD 与文件名安全化、PE 导入表解析（真实 `ggml-cuda.dll`）、环境自检各判定分支、数据落点三种情形、
llama.cpp 目录的向上回溯探测（含层数上限与环境变量优先）、模型布局探测（models 目录 / presets.ini / 预加载）、
关窗决策表（服务在跑 / 没跑 / 已开缩托盘 / 正在退出）、便携版应用目录的解析。

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

   后果是网页下拉框里多一个假模型、并白占一个 `--models-max` 槽位。
   **这条现在已经从根上消失了**：预设以配置里的 JSON 为准，递给服务器的 ini 是启动器生成的，
   只会写出真实模型段（见上文「模型预设：写在配置里」）。

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
| `一键启动脚本\presets.ini` | **一次性导入来源**：`init` 与界面「导入 presets.ini…」把它的模型段转成配置里的 `presets`（fixtures 里有一份副本用于测试）。之后以配置为准，不再依赖这个文件 |

## 模型预设：写在配置里（`presets`）

预设不再是外部 ini，而是配置 JSON 的一个字段 —— **模型名 → 参数表**，键名沿用 llama.cpp
`--models-preset` 自己的键（不发明新方言，llama.cpp 将来加键也不用改代码）：

```jsonc
{
  "mode": "router",
  "models_dir": "E:\\Code\\llama\\models",
  "preload_model": "Qwen3.8-27B-Uncensored-IQ4_XS",
  "presets": {
    "Qwen3.8-27B-Uncensored-IQ4_XS": {
      "ctx-size": 16384, "cache-type-k": "q4_0", "cache-type-v": "q4_0",
      "fit-target": 1024, "load-mode": "mmap+mlock", "threads": 6
    },
    "qwen2.5-7b-instruct-q4_k_m": {
      "ctx-size": 32768, "cache-type-k": "q8_0", "cache-type-v": "q8_0",
      "fit-target": 1024, "load-mode": "mmap+mlock", "threads": 6
    }
  }
}
```

- 段名（对象键）= 模型名（GGUF 文件名去掉 `.gguf`），与 llama-server 的 `Available models` 一致。
- 值只支持字符串 / 数字 / 布尔，**写什么就传什么**（`ctx-size` 也可以写成 `"16384"`）。
- 启动时由 `renderPresetFile()` 渲染成 llama-server 认的 ini 写到 `%TEMP%\llama-launcher-presets.ini`，
  再把那个路径交给 `--models-preset`。所以**再也不会有"中文路径把服务器搞崩退"和
  `[defaults]` 被当成假模型**这两件事（生成的那份 ini 里只有真模型段）。
- 预设里定义过的键，命令行不再重复传（preset 与命令行的优先级见上文「关键设计决策」第 4 条）。
- 界面左栏显示"已为 N 个模型定义预设"+ 清单，不想手写 JSON 就点「导入 presets.ini…」把旧文件转进来
  （同名模型不覆盖，导入结果会写盘并给出通知）。

老配置（只有 `models_preset` 路径、没有 `presets`）**打开时会自动导入**：读那个 ini、转成 JSON 预设留在内存里，
并给出 ℹ 通知「点『保存』写入文件」。导入是一次性的补充动作，不会覆盖你已经调过的同名模型。

**实测**（真实 llama-server，b10488）：把上面那份配置跑起来，服务器日志是

```
load_models: Loaded 5 custom model presets from C:\Users\feng\AppData\Local\Temp\llama-launcher-presets.ini
operator(): Available models (5) (*: custom preset)
operator():   * Qwen3.8-27B-Uncensored-IQ2_M
operator():   * Qwen3.8-27B-Uncensored-IQ4_XS
operator():   * meta-llama.Meta-Llama-3-8B-Instruct.Q4_K_M
operator():   * qwen2.5-7b-instruct-q4_k_m
operator():   * qwen2.5-7b-instruct-q5_k_m
```

5 个模型全带 `*`（都吃到了自定义 preset），而且**没有**多出来的 `* defaults` 假模型。
| `llamaServer启动器\反编译输出\` | 仅作**功能需求参考**（v1.9 的配置字段、UI 分区、GPU 监控方式）。版权归原作者（bilibili:hsxbxq），**不复制其代码、样式与文案、不二次分发** |
| `llamaServer启动器\llama_launcher_config.json` | 仅作**字段命名参考**（哪些参数值得建模、默认值取多少）。启动器**不提供**导入它的功能，配置由 `init` / 界面生成 |

## 已知偏离与待确认

1. **思考开关**：新版本优先用 `--reasoning on/off/auto`（比 PS1 的 `--reasoning-budget 0` + 环境变量更直接），
   旧版本才回退到 PS1 那套双管齐下。
2. **`context: 64` 的单位**：`context` 落在 1..512 且没写 `contextUnit` 时，按「K」解释成 65536 tokens
   （16K 档在 PS1 里写的是 32768，64 不可能是 token 数）。这条只**识别 + 明确告警**，不静默改数。
   若你原本就想要 64 tokens，把 `context` 显式写成 `64` 并加 `"contextUnit": "tokens"`。
3. **`presets.ini` 里那行 `; default-model = Qwen3.8-27B-Uncensored-IQ4_XS` 是注释，但 PS1 的读取逻辑仍然认它** ——
   也就是说你原来的脚本**每次启动都会预加载 27B 模型**。`init`/导入时会把这条约定读出来写进配置的 `preload_model`。
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
- 托盘创建失败**不影响程序启动**（会被 try/catch 包住并打错误日志），界面与 CLI 照常可用

#### 点窗口 ✕ 时会发生什么（「智能 ✕」）

早先的默认是「关窗即缩到托盘」，结果是"明明点了 ✕，任务管理器里四个进程还在"，很吓人。
现在默认**不缩托盘**，改成按情况处理，决策逻辑在 `src/main/closePolicy.ts`（纯函数，有单测）：

| 情况 | 行为 |
| --- | --- |
| 服务没跑 | **直接退出**（点 ✕ 就该关掉，这是大多数人的直觉） |
| 服务在跑 | 弹一次确认：**退出并停止服务** / **缩到托盘继续跑** / 取消 |
| 用户显式开了「关闭窗口时缩到托盘」 | 只隐藏窗口，不再询问（那是这个开关的语义） |
| 已经在退出流程里 | 一律放行（否则永远退不掉） |

> 任务管理器里看到 4 个 `llama-launcher.exe` 是**正常**的：那是 Electron 一个应用的进程族
> （主进程 + 渲染进程 + GPU 进程 + 网络/工具进程），同属一个实例，不是四个副本。
> 点「退出」之后它们会一起消失；在任务管理器里直接结束进程虽然也行，
> 但会留下占着显存的 llama-server 孤儿进程 —— 所以退出统一走应用自己的路径。

真正的退出（含上面那个确认框选"退出并停止服务"）会先 `stop()` 停掉 llama-server
（含 `taskkill /T /F` 兜底）再 `app.quit()`，不留占显存的孤儿进程。

**已实测**（`WM_CLOSE` 等价于点 ✕）：

```
服务没跑时           : 收到 WM_CLOSE 后 5 秒内进程消失
服务在跑时           : 进程仍在，且多出一个标题为「llama-server 正在运行」的模态框
点「退出并停止服务」 : 启动器退出，llama-server 进程数归 0
```

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
pnpm package:portable   # → dist/llama-launcher-<版本>-portable.exe ：单文件便携版
pnpm package:check      # 只做打包前诊断：报告哪个文件被占用、本次会输出到哪里
```

单文件便携版**已实跑验证**：那个 exe 拷到哪儿都能双击启动，配置与数据生成在**它自己旁边**
（不是 `%TEMP%`，也不是 `%APPDATA%`），改完配置文件下次启动照旧生效。

> 打便携版时 electron-builder 要下载 7za / NSIS 工具链，**回来的是 GitHub 的地址**，
> 在国内会 `connect ETIMEDOUT`。加一个镜像环境变量即可（实测通了）：
>
> ```powershell
> $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
> pnpm package:portable
> ```
>
> 工具链下过一次就有缓存，之后不用再带这个变量。

产物里**只有启动器自己**（`out/` 三份产物 + `package.json`）：llama.cpp 与模型都留在外面 ——
它们是几十 GB 的东西，而且你本来就会换构建版本，打进去反而没法换。启动器启动时按配置去找
`llama-server.exe`。

#### 为什么要经过 `scripts/package.mjs`

不是包装，而是绕开两个真实存在的坑：

1. **让产物里不出现任何 `.asar` 文件。** 自定义 `electronDist` 时 electron-builder 走的是
   "custom unpacked Electron distribution" 分支，它做三件事：
   `emptyDir(appOutDir)` → `copyDir(发行目录 → 产物)` → `return false`。
   最后那个 `false` 让 `isFullCleanup=false`，于是 `cleanupAfterUnpack()` 里
   `unlinkIfExists(产物/resources/default_app.asar)` **被整个跳过**（不是「删失败」，是压根不删）。
   结果每个产物里都会留一份 Electron 自带的 `default_app.asar`，而下一次打包开头的
   `emptyDir(appOutDir)` 必须把它删掉 —— 那一步不吞错误，于是一旦它被别的进程占用，
   整个打包就以 `EBUSY: resource busy or locked, unlink '...\default_app.asar'` 中断。
   脚本生成的 `.electron-dist/` 是发行目录的**过滤镜像**（跳过这个 asar，其余 72 个文件用 NTFS
   硬链接指过去，不占额外空间），`electron-builder.yml` 的 `electronDist` 指向它；再加上
   `asar: false`，产物里就一个 `.asar` 都没有了。
2. **清理失败就换目录，而不是让整个打包失败。** 万一还有别的文件被占用（比如刚生成的 exe 正被杀软
   扫描），脚本会把占用文件逐条列出来、自动改用带时间戳的备用目录
   `dist-fallback-<yyyyMMddHHmmss>`，并告诉你两条出路（重启释放 / 加白名单）。

输出目录默认是项目内的 `dist/`，可以用环境变量改到工作区之外：

```powershell
$env:LLAMA_PACKAGE_OUT='E:\llama-launcher-dist'
pnpm package
```


### 数据放哪儿：便携优先

策略在 `src/main/paths.ts`（有单测覆盖各种情形）：

| 情形 | 配置 | Chromium 运行时数据 |
| --- | --- | --- |
| 开发模式（未打包） | 项目根目录 | Electron 默认 userData（不动它） |
| **打包后，exe 目录可写** | **`<应用目录>/llama-launcher.json`** | **`<应用目录>/data/`** |
| 打包后，exe 目录只读（如装进 `Program Files`） | `%APPDATA%\llama-launcher\` | 同左 |

其中「应用目录」由 `resolveAppDir()` 决定，**不是简单的 `dirname(app.getPath("exe"))`**：
单文件便携版（`portable` 目标）每次启动都会把自己解压到 `%TEMP%\<随机名>\`，
`app.getPath("exe")` 指的是那个临时目录 —— 直接用它的话配置会写进临时目录，
而下次启动解压出的目录名又不一样，用户看到的现象就是 **「便携版每次启动配置都被重置」**。
electron-builder 的 `portable.nsi` 为此注入了 `PORTABLE_EXECUTABLE_DIR`（= 便携 exe 真正所在的目录），
有它就以它为准（这条路径有 4 个单测）。

也就是说：**便携模式下整个文件夹拷走就等于把配置与数据一起带走，`%APPDATA%` 里不留任何东西**
（实测：清空 `%APPDATA%\llama-launcher` 后跑一次打包产物，那个目录不会被再创建，而 exe 旁边
出现了 `llama-launcher.json` 与 `data/`）。界面左栏「启动器设置」里把这三条路径直接显示出来。

对单文件便携版实测过两件事：配置与数据生成在**便携 exe 旁边**；把 `port` 手改成 18080 后
再启动一次，界面里读到的就是 18080（说明读的是同一个文件，不是每次重新生成）。

### 首次运行：自动生成配置并重新加载

exe 旁边还没有配置时，启动过程是「**生成 → 重新读一遍**」：

1. 用默认值 + **自动探测到的整套布局**拼出初始配置，写到磁盘：
   `llama.cpp` 目录 → 同级 `models` 目录 → `presets.ini`（据此定 `mode`，
   **并把它的模型段转成配置里的 `presets`**）→ presets 的 `[defaults]` 约定决定是否预加载。
   探测规则来自 core 的 `discoverModelLayout()`，与 CLI 的 `init` **共用同一份实现**（7 个单测）
2. **把它当普通配置文件重新读一遍**（`loadConfigFile`），用读回来的结果作为当前配置

第 2 步不是多余的：这样"首次运行的内存状态"与"第二次启动读文件的状态"完全一致，
不会出现"这次能用、下次启动表现不同"的怪现象。生成的配置就在 exe 旁边，可以直接用编辑器改。

> 早先这里**只探 `llama.cpp` 目录**，于是打包版第一次运行拿到的配置是 `mode: single` + 空的
> `models_dir`；用户一切到 router 就被告警"没有任何可用模型"。更坑的是输入框里有行灰色的
> `placeholder`（当时写死成 `E:\Code\llama\models`），看着像默认值、其实不是值 ——
> 于是"明明有默认值为什么还报警"就成了必踩的坑。现在两条都处理了：
> 首次运行一次探齐，输入框的灰字也改成不具误导性的提示，
> 并在**确实探到**候选路径时给一个「填入探测值」按钮（可点，不是灰字）。

界面上这件事是 **ℹ 通知**（不是 ⚠ 警告）：

```
ℹ 首次运行：已在 <exeDir>\llama-launcher.json 生成默认配置（可以直接编辑这个文件）
ℹ 已自动探测到 llama.cpp 目录：E:\Code\llama\llama.cpp
ℹ 已自动探测到模型目录：E:\Code\llama\models
ℹ 已自动探测到 presets.ini：E:\Code\llama\一键启动脚本\presets.ini（运行模式已设为 router），其中 5 个模型的预设已导入配置的 presets 字段
ℹ 按 presets.ini 的 default-model 约定设置了预加载：Qwen3.8-27B-Uncensored-IQ4_XS
```

（后三行是本次实测导出的界面文本，原样抄自 `out/ui-firstrun-json.txt`。实测生成的配置里
`mode: router`、`models_dir` 有值、`presets` 里有 5 个模型、`models_preset` 为空 —— 也就是说
**新配置不再依赖那个 ini 文件**。）

**模型目录必须写进配置**：`--models-dir` 是 llama-server 真正收到的东西，router 模式靠它列出可用模型；
配置里的预设（`presets`）只负责给各模型**覆盖参数**，不能代替它。空着启动，网页左上角一个模型都不会有。
界面上的判断方法很简单：那行路径是**灰字**就是没设置（只是示例），黑色才是真写进去了。

> 早先的写法在这里报的是「配置文件不存在…已使用默认值」，明明已经生成好了却先报一句像错误的话
> —— 现在这类中性信息走 `BootstrapPayload.notices`，与真正的 `warnings` 分开渲染。

### 自动探测 llama.cpp 目录：以应用目录为锚，向上回溯 3 层

`discoverLlamaDir` 的顺序是：环境变量 `LLAMA_SERVER` / `LLAMA_DIR` → 逐个起点目录，**每层检查
「该层本身」与「该层的 `llama.cpp/`」后向上回溯最多 3 层**。起点列表是「应用目录」
（`resolveAppDir()`：便携版是便携 exe 所在目录，其余情况是 exe 所在目录）→ cwd → 配置里写的目录。

为什么不能只用 cwd：便携版双击启动时 cwd 是 exe 目录（甚至可能落在系统目录），
而常见布局是「项目目录下并列着 `llama.cpp` 与 `llama-launcher\dist\win-unpacked\`」——
从 exe 往上数正好三层。早先只查"自己 / 自己下面 / 上一级"，于是首次运行生成的配置里
`llama_dir` 是空的（用户看到的现象就是"提示配置文件不存在 + 构建目录为空"）。
现在这条路径有 7 个单测覆盖（含层数上限、多起点顺序、环境变量优先）。

> 踩过的坑：`app.getPath("userData")` **这个调用本身会把目录建出来**。
> 早先的写法在"决定落点"之前就调它取默认路径，结果便携模式下也在 `%APPDATA%` 里留了个空目录。
> 现在 `chooseDataLayout` 的 `defaultUserDataDir` 是**惰性求值**的（传函数），只在真要回退时才去问它。

**已实测**：打包出的 `llama-launcher.exe` 能独立运行，自己探测到 `E:\Code\llama\llama.cpp`，
自检面板正常显示「构建需要 CUDA 12 / 驱动支持 12.7 / RTX 4060 Ti」。

#### 打包时踩的四个坑（前三个写进 `electron-builder.yml` 注释，第四个写进 `scripts/package.mjs`）

1. **electron-builder 26.x 有个上游 bug**：它的 `resolveCacheMode` 读 `@electron/get` 的
   `ElectronDownloadCacheMode`，但依赖范围写的是 `^3.0.0`，而 **3.0.0 并不导出该符号**（3.1.0 才导出），
   于是报 `Cannot read properties of undefined (reading 'ReadWrite')`。
   绕法：`electronDist` 指向已解压的发行目录，不走那条下载路径。
2. **`@electron/get` 版本被迫顶到 3.1.0**（写进 `pnpm-workspace.yaml` 的 `overrides`）：
   `app-builder-lib` 声明的是 `^3.0.0`，而 3.0.0 不导出 `ElectronDownloadCacheMode`，于是报
   `Cannot read properties of undefined (reading 'ReadWrite')`。这一个 override 同时修好了
   **免安装目录与便携版**（先前以为"安装包走的是同一条坏路径、所以打不出来"，实测是错的 ——
   便携版打不出来只是网络问题，见上面的镜像变量）。排查时注意：`.pnpm/` 里可能同时留着
   新旧两个 `app-builder-lib@*` 目录，**别用 `Select-Object -First 1` 去读，会读到废弃的那个**
   （我就这么误判过一次）。
3. **图标给现成的 `.ico`**，不要让 electron-builder 从 PNG 转换（它的转换要调 app-builder 的二进制，本机报错）。
   `build/icon.ico` 是手写的：ICO 头 + 内嵌一张 256×256 PNG（Windows Vista+ 原生支持这种形式）。
4. **产出的 `.asar` 会被本机的常驻进程长期占用，进而毒掉下一次打包**（详见「为什么要经过
   `scripts/package.mjs`」）。这里补一个实测数据，因为它决定了怎么修：本机残留的 4 个 `.asar`
   在**几个小时之后**依然处于「可正常读取、但改不了名也删不掉」的状态；而同一目录下新建的普通文件
   （含一个内容仿造的 `.asar`）都能立刻改名/删除。当前在跑的相关进程是火绒
   （`HipsDaemon` / `HipsTray`）、Everything 与 Windows 搜索 —— 大概率是其中之一在解析 `.asar`。

> **已经残留的目录怎么办**：`dist\win-unpacked`、`release\win-unpacked`（早期试过的输出目录）以及
> `dist-fallback-*` 里面那些 `.asar` 现在还删不掉，**重启一次电脑即可释放**，之后
> `pnpm package` 会自动回到 `dist/`（本次实测：往干净目录连续打包两次都成功，第二次清理掉了上一次的 95 项产物，
> 正是原先必然 EBUSY 的那一步）。
> 想一劳永逸：把项目目录与输出目录加进火绒的**信任区**，或在 Everything 里关掉内容索引。

> 另一条早期误判也顺便纠正一下：先前以为是「受管沙箱的文件观察层持有刚生成的文件，所以在工作区里打包才报
> `EBUSY`，用户自己的终端没问题」。**结论是错的** —— 你在自己的终端里跑 `pnpm run package` 复现了同样的错误。
> 真实原因是上面第 4 条：产物里的 `.asar` 被常驻进程占用，与在哪个终端、哪个目录构建无关。

## 下一步（M5）

- ~~**单文件安装包**~~ ✅ 已完成：`pnpm package:portable` 出便携版单 exe（`nsis` 安装程序同理，
  只是本机没实跑安装流程）
- **HF 镜像下载**：接 `hf-mirror`，带进度与断点续传；以及 `llama-quantize` / `gguf-split` 的图形化
- **预设可视化编辑**：格式已经是配置里的 JSON（见「模型预设：写在配置里」），下一步是在界面里增删改模型段，不必手写 JSON
- **多实例管理**：同时跑多个 llama-server，各自分配端口与显卡

数据源与纯逻辑会继续留在 core 侧（可单测），界面只做展示。
