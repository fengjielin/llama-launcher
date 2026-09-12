/**
 * main / preload / renderer 三端共享的 IPC 契约。
 *
 * 这里只放**类型与通道名**：core 里的业务类型原样复用（`import type`，编译后被抹掉），
 * 避免界面层另造一套 DTO 然后跟 core 慢慢漂移。
 *
 * `LlamaApi` 是全程序唯一的前端调用面：preload 实现它，renderer 只认它。
 * 将来若把 Electron 换成别的壳，只要新壳再实现一遍这个接口即可。
 */

import type { BuildStep, LauncherConfig } from "../core/types.ts";
import type { ParamGroup, ValueKind } from "../core/types.ts";
import type { LogEventKind, LogMetrics } from "../core/logLines.ts";
import type { MetricsSample, MetricsSeries } from "../core/metrics.ts";
import type { PrecheckReport } from "../core/precheck.ts";
import type { ProfileInfo } from "../core/profiles.ts";

export const IPC = {
  /** 启动时拉取：配置路径、归一化配置、参数表 */
  bootstrap: "app:bootstrap",
  /** 打开已有配置 */
  configOpen: "config:open",
  /** 保存到当前路径 */
  configSave: "config:save",
  /** 另存为 */
  configSaveAs: "config:saveAs",
  /** 从 presets.ini 导入模型预设到配置的 presets 字段 */
  presetsImport: "presets:import",
  /** 弹系统文件/目录选择框 */
  pickPath: "dialog:pickPath",
  /** 现场跑 --version/--help，重算能力视图 */
  detect: "llama:detect",
  /** 跑一遍环境自检（驱动/CUDA 运行时/模型/端口） */
  precheck: "precheck:run",
  /** 只拼命令行并给出决策表（不启动进程） */
  preview: "llama:preview",
  start: "llama:start",
  stop: "llama:stop",
  status: "llama:status",
  health: "llama:health",
  openWebUi: "shell:openWebUi",
  revealPath: "shell:revealPath",
  /** 界面刚加载时拉取主进程缓存的历史日志 */
  logsRecent: "logs:recent",
  /** 拉取一次指标快照（含历史序列） */
  metricsSnapshot: "metrics:snapshot",
  /** 打开/关闭实时指标推送（界面切到「监控」页时才开，避免白烧 nvidia-smi） */
  metricsWatch: "metrics:watch",
  /** 档案：列出 / 保存 / 载入 / 删除 / 在资源管理器里定位 */
  profilesList: "profiles:list",
  profilesSave: "profiles:save",
  profilesLoad: "profiles:load",
  profilesDelete: "profiles:delete",
  profilesReveal: "profiles:reveal",
  /** 应用设置：开机自启、关闭窗口是否缩到托盘 */
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  /** 主进程 → 渲染层的推送 */
  pushLog: "push:log",
  pushState: "push:state",
  pushMetrics: "push:metrics",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ---------------------------------------------------------------------------
// 参数表（schema 驱动表单的数据源）
// ---------------------------------------------------------------------------

export interface SchemaEntry {
  key: string;
  label: string;
  group: ParamGroup;
  kind: ValueKind;
  candidates: string[];
  presetKey?: string;
  enumValues?: string[];
  hint?: string;
  /** null = 还没探测过，不确定当前 llama.cpp 支不支持 */
  supported: boolean | null;
  /** 探测后实际使用的参数名 */
  resolvedFlag: string | null;
  /** 该参数在当前版本里是否接受值（`[on|off|auto]` 算接受） */
  takesValue: boolean;
  /** 命中的参数在 help 里被标了 DEPRECATED */
  deprecated: boolean;
}

export interface SchemaPayload {
  groups: { id: ParamGroup; label: string }[];
  entries: SchemaEntry[];
}

// ---------------------------------------------------------------------------
// 载荷
// ---------------------------------------------------------------------------

export interface BootstrapPayload {
  configPath: string;
  config: LauncherConfig;
  /** 需要用户留意的问题（配置矛盾、探测失败等），界面上以 ⚠ 展示 */
  warnings: string[];
  /**
   * 中性通知（不是问题），例如"首次运行已生成默认配置"、"已自动探测到 llama.cpp 目录"。
   * 与 warnings 分开，是为了不把"刚生成好配置"这种好消息渲染成一条警告。
   */
  notices: string[];
  /**
   * 探测到的、可以一键填入的路径（值为空串表示没探到）。
   *
   * 界面用它渲染「填入 …」按钮：输入框为空时那行灰色文字只是**示例**而不是值，
   * 真正探到的路径走这里 —— 免得用户以为已经设过了（踩过：以为 `models_dir` 有默认值，
   * 切到 router 后被告警"没有任何可用模型"）。
   */
  suggestions: PathSuggestions;
  schema: SchemaPayload;
  platform: string;
  /** true = 当前运行在 Electron 里；false = 浏览器回退壳 */
  inDesktopShell: boolean;
}

/** 见 {@link BootstrapPayload.suggestions}：只包含**确实存在**的路径 */
export interface PathSuggestions {
  /** llama.cpp 同级的 `models` 目录（存在才有值，否则空串） */
  modelsDir: string;
  /** 探测到的 `presets.ini` 完整路径（存在才有值，否则空串） */
  presetPath: string;
}

export interface DetectPayload {
  ok: boolean;
  /**
   * 探测没能完成的原因。
   * 刻意不叫 error —— 顶层 `ErrorPayload` 就是用 `error` 字段做判别的，
   * 这里若同名会让 `isErrorPayload()` 把它误判成错误载荷。
   */
  failure?: string;
  exe: string;
  build: number | null;
  versionLine: string;
  optionCount: number;
  sections: string[];
  unsupported: { key: string; label: string; candidates: string[] }[];
  renamed: { key: string; label: string; used: string; preferred: string }[];
  deprecated: { key: string; label: string; flag: string }[];
  schema: SchemaPayload;
}

export interface PresetPayload {
  /** 真正传给 llama-server 的路径 */
  argPath: string;
  /** 是否因为非 ASCII 路径 / 剔除启动器自用段而做了临时拷贝 */
  staged: boolean;
  /** 原文件里所有模型段出现过的键（并集，与 PS1 行为一致） */
  presetKeys: string[];
  /** [defaults] 段里的 default-model */
  defaultModel: string | null;
  /** 模型段名列表 */
  models: string[];
}

/**
 * 决策表的一行：core 的 BuildStep 加上格式化好的命令行文本。
 * 格式化在主进程做（复用 core 的 formatArgv），渲染层就不必为了显示再拼一次命令。
 */
export interface StepView extends BuildStep {
  argvText: string;
}

export interface PreviewPayload {
  exe: string;
  host: string;
  port: number;
  argv: string[];
  command: string;
  env: Record<string, string>;
  steps: StepView[];
  warnings: string[];
  preset: PresetPayload | null;
  preloadModelFile: string | null;
}

export interface DiagnosisPayload {
  code: string;
  summary: string;
  suggestions: string[];
}

export interface StartReportPayload {
  pid: number | null;
  ready: boolean;
  waitedMs: number;
  state: string;
  note: string;
  diagnosis: DiagnosisPayload | null;
}

export interface StartPayload extends PreviewPayload {
  report: StartReportPayload;
  baseUrl: string;
}

export interface HealthPayload {
  state: "ready" | "loading" | "error" | "unreachable";
  httpStatus?: number;
  detail?: string;
}

export interface StatusPayload {
  state: string;
  note: string;
  pid: number | null;
  running: boolean;
  baseUrl: string;
  health: HealthPayload | null;
  /** 最近生效的那条命令行，便于界面上随时回看 */
  lastCommand: string | null;
}

export interface LogPush {
  seq: number;
  at: number;
  line: string;
  kind: LogEventKind;
  level: "info" | "warn" | "error";
  metrics: LogMetrics;
}

export interface StatePush {
  state: string;
  note: string;
  health: HealthPayload | null;
}

export interface ErrorPayload {
  error: string;
}

export type PickKind = "gguf" | "directory" | "ini" | "json";

export interface PickPathRequest {
  kind: PickKind;
  title?: string;
  defaultPath?: string;
}

export interface PickPathResult {
  canceled: boolean;
  path: string | null;
}

export interface ConfigFileResult {
  canceled: boolean;
  path: string | null;
  payload: BootstrapPayload | null;
  warnings: string[];
}

/**
 * 指标快照：一次性给全界面画图所需的数据。
 *
 * `series` 是 `latest` 所在整段历史的"按指标分列"形式，渲染层直接按下标画折线，
 * 不需要自己遍历样本。
 */
export interface MetricsPayload {
  /** 最近一次采样；从未采过时为 `null` */
  latest: MetricsSample | null;
  /** 历史序列（各列等长，与 `series.at` 对齐） */
  series: MetricsSeries;
  /** 采样器是否正在跑 */
  running: boolean;
  /** GPU 采集失败的原因（没装 nvidia-smi / 非 NVIDIA 机器）；正常时为 `null` */
  gpuError: string | null;
}

/** 档案列表 */
export interface ProfilesPayload {
  /** 档案目录（界面展示用，也方便用户直接去那儿拷文件） */
  dir: string;
  /** 按最后修改时间从新到旧 */
  profiles: ProfileInfo[];
}

/** 载入档案的结果：成功时 `payload` 是完整的初始化载荷（与换配置同构） */
export interface ProfileLoadResult extends ConfigFileResult {
  /** 被载入的档案名 */
  name: string | null;
}

/**
 * 应用级设置（启动器自己的偏好，与"启动配置"无关）。
 *
 * 只有这两项是**持久化**的；`autostartSupported` 是运行时探测结果，不进磁盘。
 */
export interface AppSettings {
  /** 开机自启（写进系统登录项） */
  openAtLogin: boolean;
  /** 关闭窗口时缩到托盘而不是退出（服务会继续跑） */
  minimizeToTray: boolean;
}

/** 设置载荷：持久化字段 + 运行时信息 */
export interface AppSettingsPayload extends AppSettings {
  /** 当前平台是否支持开机自启（Linux 上需要桌面项，未实现） */
  autostartSupported: boolean;
  /** 设置文件的落盘位置（界面展示用，方便用户直接查） */
  settingsPath: string;
  /** Chromium 运行时数据目录（缓存等）；便携模式下在 exe 同级的 data/ 里 */
  dataDir: string;
  /** 当前生效的配置文件路径 */
  configPath: string;
  /**
   * 是否处于便携模式：配置与数据都在 exe 同目录，`%APPDATA%` 里不留东西。
   * 只有打包后且 exe 目录可写时才为 `true`。
   */
  portable: boolean;
}

export function isErrorPayload(value: unknown): value is ErrorPayload {
  return typeof value === "object" && value !== null && "error" in value;
}

/** 前端唯一调用面。preload 实现它，renderer 只依赖它。 */
export interface LlamaApi {
  bootstrap(): Promise<BootstrapPayload>;
  openConfig(): Promise<ConfigFileResult>;
  saveConfig(config: LauncherConfig): Promise<{ ok: boolean; path: string; warnings: string[] }>;
  saveConfigAs(config: LauncherConfig): Promise<{ canceled: boolean; path: string | null }>;
  /**
   * 选一个 presets.ini 把里面的模型预设并进配置（预设现在以配置里的 `presets` 字段为准）。
   *
   * 取消时 `canceled` 为 true；失败时 `warnings` 里带原因（界面不崩）。
   */
  importPresets(): Promise<ConfigFileResult>;
  pickPath(request: PickPathRequest): Promise<PickPathResult>;
  detect(): Promise<DetectPayload | ErrorPayload>;
  /** 环境自检：驱动是否配得上这份构建、运行时 DLL 齐不齐、模型能不能装下等 */
  precheck(force?: boolean): Promise<PrecheckReport>;
  preview(config: LauncherConfig): Promise<PreviewPayload | ErrorPayload>;
  start(config: LauncherConfig): Promise<StartPayload | ErrorPayload>;
  stop(): Promise<{ ok: boolean }>;
  status(): Promise<StatusPayload>;
  health(): Promise<HealthPayload>;
  openWebUi(): Promise<{ ok: boolean; url?: string }>;
  revealPath(path: string): Promise<{ ok: boolean }>;
  /** 拉取已缓存的历史日志（界面刚加载时用） */
  recentLogs(): Promise<LogPush[]>;
  onLog(handler: (entry: LogPush) => void): () => void;
  onState(handler: (state: StatePush) => void): () => void;

  // ---- 指标监控（M3）----
  /** 拉一次指标快照（含历史序列），用于首次绘制 */
  metricsSnapshot(): Promise<MetricsPayload>;
  /** 开关实时推送：界面切到「监控」页时传 true，离开时传 false */
  metricsWatch(active: boolean): Promise<{ ok: boolean; running: boolean }>;
  /** 订阅每次采样（仅在 watch 为 true 期间会收到）；载荷含历史序列，直接替换本地状态即可 */
  onMetrics(handler: (payload: MetricsPayload) => void): () => void;

  // ---- 配置档案（M3）----
  listProfiles(): Promise<ProfilesPayload>;
  saveProfile(name: string, config: LauncherConfig): Promise<{ ok: boolean; profiles: ProfileInfo[]; saved: string }>;
  loadProfile(name: string): Promise<ProfileLoadResult>;
  deleteProfile(name: string): Promise<{ ok: boolean; profiles: ProfileInfo[] }>;
  revealProfiles(): Promise<{ ok: boolean; dir: string }>;

  // ---- 应用设置（M3）----
  getSettings(): Promise<AppSettingsPayload>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettingsPayload>;
}
