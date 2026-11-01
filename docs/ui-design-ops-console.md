# UI 设计规范：本地推理运维台（Ops Console）

> 状态：已定稿方向，**先规范、后改代码**。
> 适用：`src/renderer`（Electron + React + Tailwind v4）。
> 产品定位：llama.cpp 桌面启动器 —— 选模型 → 拼命令 → 启停服务 → 看健康/显存/日志。

---

## 1. 为什么改

### 现有视觉（问题）

| 现象 | 证据 |
| --- | --- |
| 通用「深色 AI 工具壳」 | 背景 `#0b0e14` + 主操作 `sky-600`，接近常见 AI 仪表盘模板 |
| 信息平铺、主次弱 | 顶栏徽章、命令条、左侧长表单、五标签页同权重 |
| 字体偏系统默认 | `Segoe UI` / `Microsoft YaHei UI`，缺少工具品牌感 |
| 状态靠散落 Badge | 成功/失败/健康/忙碌都用小徽标，扫读成本高 |
| 卡片堆叠 | `Section` / 参数分组均为 `rounded-lg + border + #11151d` 卡片 |

### 产品真正的主路径

1. 选模式（单模型 / router）与模型路径  
2. 看「实际启动命令」是否可信  
3. 启动 / 停止 / 打开 Web UI  
4. 看状态栏：running · PID · baseUrl · 健康  
5. 出问题时切：自检 → 日志 → 决策表  

参数表、决策表、监控是**运维次级工具**，不应与「启停」抢第一眼。

### 推荐方向（已确认由助手选定）

**运维控制台（Ops Console）**：保留深色与信息密度，但重建层级 ——  **启动/健康/显存优先**，参数与决策降为次级；色调改为**石墨 + 青绿/琥珀状态色**，去掉 sky 蓝的「通用 AI 产品」感。

不采用：浅色实验台（偏离现有习惯）；纯硬件台架风（监控会压过启停主路径）。
可吸收：冷静工作台的「渐进披露」—— 高级参数默认折叠。

---

## 1.5 行业怎么「脱离 AI 设计风」

本地推理 / 开发者工具若做成「紫霓虹仪表盘」，会立刻像套壳 AI SaaS。行业里成熟做法是：**按 IDE / 终端 / 运维台来设计，而不是按 Chatbot 产品页来设计。**

### 同类与邻近产品在做什么

| 参考 | 做法 | 对本项目的启示 |
| --- | --- | --- |
| [LM Studio · User / Developer](https://lmstudio.ai/docs/app/user-interface/modes) | 默认偏聊天与自动配置；Developer 才露出加载/推理参数与高级能力 | 我们本身是启动器/运维面，应对齐 **Developer 面**：参数、命令、自检是一等公民，不要做成「聊天外壳 + 设置抽屉」 |
| [LM Studio · Color Themes](https://lmstudio.ai/docs/app/user-interface/themes) | 主题选择是系统向的 Light / Dark / Auto，而不是营销向的霓虹皮肤墙 | 单套严肃深色 token 即可；主题扩展以后再做，先把「工具壳」做对 |
| [Graphite Shell](https://freedesignmd.com/system/graphite-shell) | 温润石墨面（既非纯黑也非冷灰）、技术面一律等宽、**单一**鼠尾草绿只用于 active | 强化「石墨阶 + 一个 accent」；禁止第二品牌色、禁止紫/靛抢戏 |
| JetBrains 系工具语汇 | 高密度 IDE 面板、工具栏可预期、状态色服务运行事实，而不是营销光谱 | 密度 > 留白奢侈；面板用分割与字重，不靠大卡片堆「高级感」 |
| VS Code / Windows Terminal 一类壳 | 功能铬（chrome）极薄，内容区（编辑器/终端）占主导 | 命令预览与日志应像「工作台内容」，顶栏不要徽章墙 |

### 「AI 设计风」识别清单（见到就改）

| 信号 | 为什么像 AI 套壳 | 运维台替代做法 |
| --- | --- | --- |
| 紫 / 靛 / 电光蓝作主色，或紫→蓝渐变 | 2023–2025 AI landing / dashboard 模板默认色 | 石墨表面 + **单一**青绿/鼠尾草 accent，只用于主操作与焦点 |
| 大面积 glow、玻璃拟态、多层阴影 | 营销页氛围，不是长时间盯屏工具 | 平面分割线；elevation 最多一级极弱 |
| 圆角胶囊 CTA、徽章墙、统计条 | 「产品感」装饰，打断扫读 | 紧凑 `6px` 控件；Badge 有配额；数字进状态栏/指标行 |
| Inter / 系统默认 + 到处 sky 蓝 | 生成式 UI 最常见组合 | Plex / Geist + Mono；语义色只表达 ok/warn/danger |
| 卡片矩阵、每块都有标题+边框+底 | 空洞的「模块感」 | 少卡片；用 `--border-subtle` 与背景阶分区 |
| 把启动器画成 Chat 产品 | 品类错位 | 隐喻：**控制台 / 进程管理器 / IDE Run 面板** |

### 可执行的「去 AI 风」策略（本项目采用）

1. **品类锚点**：文案与布局都说「启动 / 探测 / 自检 / PID / 命令行」，不说「智能 / 助手 / 对话」。
2. **一个 accent 纪律**：品牌交互色只有 `--accent` / `--accent-solid`；`info` 冷色仅用于偶发提示，绝不当主色。
3. **技术真相用等宽**：命令、路径、flag、日志、决策「实际传入」一律 mono；UI 标签用无衬线，二者分工固定。
4. **密度对齐 IDE**：行高与字号保持现状量级；用对比与字重分层，不靠留白「变高级」。
5. **状态是灯不是贴纸**：StatusBar 状态灯 + 短文案优先于散落 Badge。
6. **渐进披露学 LM Studio Developer 思路**：高级参数默认折叠，但不藏进「聊天优先」信息架构——我们没有聊天主界面。

参考链接（对照用，不引入其组件库）：

- [LM Studio · User or Developer](https://lmstudio.ai/docs/app/user-interface/modes)
- [LM Studio · Color Themes](https://lmstudio.ai/docs/app/user-interface/themes)
- [Graphite Shell DESIGN.md](https://freedesignmd.com/system/graphite-shell)

---

## 2. 设计原则（硬规则）

1. **状态优先于装饰**：任何时刻，用户应在 1 秒内回答「服务在不在跑、健不健康」。
2. **一条主命令**：界面预览命令 ≡ 实际启动命令（架构已保证；视觉上要把它做成「可信终端条」，不是普通卡片）。
3. **密度服务扫读**：参数行、决策表、日志保持紧凑；用字重/色阶分层，不靠大留白装高级。
4. **少卡片**：去掉为分区而分区的卡片壳；分区用细分割线、背景阶、标题字重即可。交互控件本身可保留轻微表面。
5. **徽标有语义配额**：同一行最多 2 个 Badge；「一切正常」不刷绿徽标噪音。
6. **品类不是 Chatbot**：布局隐喻是运维台 / IDE Run，不是对话产品；禁止把主路径做成「聊天 + 侧栏设置」。
7. **单 accent 纪律**：全局只保留一套交互强调色（青绿）；禁止第二品牌色、紫靛主色、渐变英雄区。
8. **禁止（AI 套壳黑名单）**：紫靛渐变主题、奶油底+衬线、报纸多栏、大面积 glow / 玻璃拟态、圆角胶囊堆、多层阴影、emoji 当图标、Inter+sky 默认组合、统计卡片墙。

---

## 3. 色彩体系

全部写入 CSS 变量（建议放在 `styles.css` 的 `@theme` / `:root`），组件禁止再散落硬编码 `#0b0e14` 一类魔法色（迁移期可并存）。

### 3.1 表面（石墨阶）

| Token | 值 | 用途 |
| --- | --- | --- |
| `--bg-app` | `#0c0f12` | 窗口底 |
| `--bg-panel` | `#12161b` | 侧栏 / 顶底栏 |
| `--bg-elevated` | `#171c22` | 悬停面、次级条 |
| `--bg-input` | `#0a0d10` | 输入框 / 终端条内底 |
| `--bg-command` | `#0a0e11` | 命令预览条背景 |
| `--border-subtle` | `#1c232b` | 默认分割 |
| `--border-strong` | `#2a3340` | 输入边框、焦点环底 |

### 3.2 文字

| Token | 值 | 用途 |
| --- | --- | --- |
| `--text-primary` | `#e6edf3` | 标题、关键值 |
| `--text-secondary` | `#9aa7b5` | 标签、说明 |
| `--text-muted` | `#6b7785` | 角标、路径、mono 次要 |
| `--text-inverse` | `#0c0f12` | 实心主按钮上的字 |

### 3.3 语义色（替代 sky 主色）

| Token | 值 | 用途 |
| --- | --- | --- |
| `--accent` | `#2dd4bf` | 主操作描边/文字强调、焦点环（青绿） |
| `--accent-solid` | `#0f766e` | 主按钮实心（Teal-700） |
| `--accent-solid-hover` | `#0d9488` | 主按钮悬停 |
| `--ok` | `#34d399` | running / 服务就绪 / 正常 |
| `--warn` | `#fbbf24` | starting、警告、废弃 |
| `--danger` | `#f87171` | 失败、error 自检 |
| `--info` | `#7dd3fc` | 中性提示（少用；不要当主色） |
| `--mono-emit` | `#6ee7b7` | 决策表「实际传入」、命令行高亮 |
| `--mono-env` | `#fcd34d` | 环境变量行 |

### 3.4 语义表面（半透明底）

| 场景 | 背景 | 边框 |
| --- | --- | --- |
| flash 成功条 | `ok / 12%` | `ok / 35%` |
| error / 自检失败条 | `danger / 12%` | `danger / 35%` |
| 启动失败诊断块 | `danger / 14%` | `danger / 40%` |
| 命令条 | `--bg-command` | `--border-subtle` |

### 3.5 废弃色映射（改造对照）

| 现状 | 改为 |
| --- | --- |
| `sky-500/600` 主色与 tab 下划线 | `--accent` / `--accent-solid` |
| `bg-sky-950/30` flash | ok 语义条 |
| `#0b0e14` / `#0f131b` / `#11151d` | 表面 token |
| `#1e2530` / `#2a3444` | border token |
| `violet` 命令徽标 | 改为 muted 文字标签或 `--accent` 弱标签（避免紫 AI 感） |

---

## 4. 字体

### 4.1 栈

| 角色 | 优先字体 | 回退 |
| --- | --- | --- |
| UI 正文 | **IBM Plex Sans**（可本地子集）或 **Geist Sans** | `"Segoe UI"`, `"Microsoft YaHei UI"`, sans-serif |
| 等宽 / 命令 / 路径 / 日志 | **IBM Plex Mono** 或 **Cascadia Mono** | Consolas, `"Courier New"`, monospace |
| 数字指标（可选） | 与 mono 同族 tabular-nums | — |

说明：不要上展示衬线；这是运维工具，不是品牌 landing。中文以系统雅黑/苹方补齐即可，拉丁用 Plex/Geist 拉开与「默认 Electron 壳」的差异。

### 4.2 字号阶（已有密度可微调，勿整体放大）

| 用途 | 大小 | 字重 |
| --- | --- | --- |
| 品牌名（顶栏） | 13–14px | 600 |
| 分区标题 | 12px | 600 |
| 正文 / 控件 | 12px | 400 |
| 辅助 / Badge | 11px | 500 |
| mono 命令 / 日志 | 11px | 400 |
| 极次要路径 | 10px | 400 |

---

## 5. 布局信息架构

保持现有三带结构，但重定义**视觉权重**：

```
┌─ TopBar：品牌 · 版本事实 · 配置路径 · 文件操作 ─────────────────────┐
├─ Flash / Error 条（仅有事时出现）────────────────────────────────────┤
├─ 左：运行控制栈 ──────┬─ 右：工作区 ─────────────────────────────────┤
│  [启动][停止][网页]    │  命令预览条（终端气质，最高可信区）            │
│  模式切换              │  自检失败条（条件）                            │
│  模型 / 路径 / 档案    │  Tab：参数 | 决策 | 自检 | 监控 | 日志         │
│  （长内容可滚）        │  内容区                                       │
├───────────────────────┴──────────────────────────────────────────────┤
│ StatusBar：state 灯 · note · PID · URL · health · busy · 日志行数     │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.1 权重规则

| 区域 | 权重 | 做法 |
| --- | --- | --- |
| 启停按钮组 | ★★★★★ | 实心主色 + 危险停止；固定在侧栏顶部，不随长表单滚走（侧栏内 sticky） |
| 命令预览 | ★★★★★ | 全宽终端条；`mono` + emit 色；复制按钮次要 |
| StatusBar 状态灯 | ★★★★ | 圆点/胶囊状态，比文字 Badge 更抢眼 |
| 模型选择 | ★★★★ | 紧挨启停；路径行保持紧凑 |
| 参数 Tab | ★★★ | 默认页；分组折叠，常用组展开 |
| 决策 / 自检 / 监控 / 日志 | ★★ | 同级 Tab；角标只在「需要看」时有色（error/warn） |
| 顶栏探测徽章 | ★★ | 收敛为单行事实，避免徽章墙 |

### 5.2 建议的小结构调整（可分 PR）

1. **侧栏顶部「运行」块**：启动/停止/打开网页从现有位置上提并 sticky。  
2. **顶栏瘦身**：`bxxxx` 与参数个数合并成一个弱标签；配置路径可缩为 icon+tooltip 或次要行。  
3. **Tab 角标**：`params`/`decision` 用 muted 数字；`precheck` 仅 error+warn 用 warn/danger 色；`logs` 有 error 时用 danger 点。  
4. **监控**：保留手写 Sparkline；指标卡减少边框，改用底部分割。  

---

## 6. 组件视觉细化

### 6.1 Button（`ui.tsx`）

| Variant | 样式 |
| --- | --- |
| `primary` | `--accent-solid` 底 + `--text-inverse`；悬停 `--accent-solid-hover`；**不要**再用 sky |
| `danger` | 实心 danger 或描边 danger（停止服务用实心） |
| `default` | `--bg-elevated` + `--border-strong` 细环 |
| `ghost` | 透明；悬停 `--bg-elevated` |

圆角统一 `6px`（`rounded-md`）；高度紧凑，保持 `text-xs`。

### 6.2 Badge

- 保留 tone 枚举，但 **主色从 sky → 映射到 accent/info**。  
- `violet` 保留给「preset 接管」一类罕见语义，或改名为 `special` 用低饱和青灰。  
- 默认字重 500；不要 ring 过重。

### 6.3 Input / Select / Toggle

- 边框 `--border-strong`，焦点环 `1px solid var(--accent)`（或 `outline`）。  
- Toggle 开启色：`--accent-solid`（替换 `bg-sky-600`）。  

### 6.4 Section

- **降卡片**：可改为「仅顶部分割 + 标题」，去掉厚重 `bg-[#11151d] rounded-lg border`；若保留边框，用 `--border-subtle` 且无阴影。  

### 6.5 CommandBar

- 外层：细顶线/底线，背景 `--bg-command`。  
- 命令文本：`--mono-emit`；失败时整段切 danger。  
- 「实际启动命令」用小号大写跟踪字或左侧竖色条，而不是 violet Badge。  

### 6.6 StatusBar

- `state` 用 **状态灯 + 短文案**（idle / starting / running / failed）。  
- health 与 state 并排；running+ready 时整体偏 ok 色，避免两套绿徽标打架。  

### 6.7 LogPane

- 保持等级色；`oom` 等 kind 高亮保留。  
- 工具条背景与主内容用 `--border-subtle` 分隔即可。  

### 6.8 滚动条

- track：`--bg-panel`；thumb：`--border-strong`；hover 略亮。  

---

## 7. 动效（克制，2–3 个有意动作）

1. **状态灯**：`starting` / `stopping` 使用缓慢呼吸 opacity（1.2s），`failed` 无动画。  
2. **Flash / Error 条**：高度或 opacity 150–200ms 切入。  
3. **主按钮 busy**：文案切换即可，不必转圈遮罩全窗。  

禁止大面积光晕、页面入场炫技。

---

## 8. 改造优先级（实施顺序）

| 阶段 | 内容 | 触及文件（预期） |
| --- | --- | --- |
| **P0 Token** | `styles.css` 建 CSS 变量；body 字体栈 | `styles.css` |
| **P1 原子组件** | Button / Badge / Toggle / Input / Select / Section 换 token | `ui.tsx` |
| **P2 壳层** | TopBar / StatusBar / CommandBar / App flash·tab | `TopBar.tsx` `StatusBar.tsx` `CommandBar.tsx` `App.tsx` |
| **P3 侧栏** | ModelPanel 启停 sticky、去多余卡片感 | `ModelPanel.tsx` |
| **P4 内容页** | ParamsForm / Decision / Precheck / Metrics / Log 边框与强调色 | 各 Panel |
| **P5 微调** | Tab 角标语义色、徽章墙收敛、滚动条 | `App.tsx` 等 |

原则：**先换色与字体（全局收益最大），再动布局**；不在本阶段改 IPC / core。

---

## 9. 验收清单

- [ ] 主色不再出现 `sky-*` 作为品牌/主按钮（提示类 info 可用少量冷色）  
- [ ] 深色石墨阶表面统一，无随机灰阶漂移  
- [ ] 1 秒内可读：服务是否 running + health  
- [ ] 命令预览仍是第一眼可信区，且与实际启动一致  
- [ ] 参数表扫读不差于现状（密度不显著变差）  
- [ ] 无紫渐变、无 glow 堆叠、无新增大卡片墙  
- [ ] 中文 Windows 下字体回退正常；mono 命令不裁切怪异  

---

## 10. 非目标（本规范不做）

- 不重做信息架构到「向导式三步」  
- 不引入组件库（shadcn/MUI 等）  
- 不改 core 拼装逻辑  
- 不做浅色主题（可列为后续 token 扩展）  

---

## 11. 一句话方向

把 llama-launcher 从「深色 AI 设置页」收成 **石墨底的本地推理运维台**：青绿主操作、琥珀告警、翠绿就绪，命令行与状态灯当主角，参数表继续密而可读。
