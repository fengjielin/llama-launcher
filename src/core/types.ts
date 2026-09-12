/**
 * core 层公共类型。
 *
 * 约束：本目录所有 .ts 都必须能被 Node 原生类型擦除直接运行
 * （无 enum / 无 namespace / 无构造函数参数属性 / 类型导入必须写 `import type`）。
 */

// ---------------------------------------------------------------------------
// llama-server --help 解析结果
// ---------------------------------------------------------------------------

/** --help 里的一条选项。b10488 的格式是 `-n,    --predict, --n-predict N   description`。 */
export interface HelpOption {
  /** 该选项的全部别名，含短选项，按 help 里的出现顺序 */
  flags: string[];
  /** 首选展示名：优先取第一个长选项 */
  primary: string;
  /** 值占位符：`N` / `MODE` / `[on|off|auto]` / `none,draft-simple,...`；空串 = 纯开关 */
  valuePlaceholder: string;
  description: string;
  /** 从 `(default: x)` 里取到的默认值（只取第一个逗号前的部分） */
  default?: string;
  /** 从 `(env: LLAMA_ARG_X)` 里取到的环境变量名 */
  env?: string;
  /** 描述里带 DEPRECATED */
  deprecated: boolean;
  section: string;
}

/**
 * `llama-server --help` 的完整解析结果。
 *
 * 由 {@link parseHelp} 产出，是「当前这个 llama.cpp 版本到底认哪些参数」的唯一依据。
 */
export interface HelpModel {
  /** 解析出的全部选项，顺序与 help 里一致 */
  options: HelpOption[];
  /** 别名（含短选项）→ 选项，用于按参数名快速反查；同一条选项的多个别名指向同一个对象 */
  byFlag: Map<string, HelpOption>;
  /** help 里的分节名（如 `common params`），用于展示与分组 */
  sections: string[];
}

/** 当前 llama.cpp 运行时的能力视图（唯一真源，参数名漂移全靠它兜住） */
export interface Capabilities {
  readonly model: HelpModel;
  readonly raw: string;
  has(flag: string): boolean;
  option(flag: string): HelpOption | undefined;
  /** 按优先级返回第一个被当前版本支持的参数名；都不支持返回 null */
  pick(candidates: readonly string[]): string | null;
  /** 该参数是否接受值（占位符非空；`[on|off|auto]` 也算接受值） */
  hasValue(flag: string): boolean;
  /** 占位符里能解析出的枚举候选，解析不出返回 null */
  enumValues(flag: string): string[] | null;
}

// ---------------------------------------------------------------------------
// 声明式参数表
// ---------------------------------------------------------------------------

/** 参数在 GUI 里的分组，决定参数表单折叠成哪几节 */
export type ParamGroup =
  | "model"
  | "server"
  | "context"
  | "sampling"
  | "perf"
  | "spec"
  | "reasoning"
  | "tools"
  | "misc";

/** 参数值类型，决定 GUI 用哪种输入控件（开关 / 数字框 / 下拉 / 文本框） */
export type ValueKind = "int" | "float" | "string" | "bool" | "enum";

export interface ParamSpec {
  /** 配置键名（LauncherConfig 里的字段） */
  key: string;
  /** GUI 显示名 */
  label: string;
  group: ParamGroup;
  kind: ValueKind;
  /**
   * CLI 参数名候选，按优先级排列。
   * 同一个语义在不同 llama.cpp 版本里改过名的，全部列在这里 —— 例如草稿模型 KV 量化：
   * 早期构建里叫 `--draft-type-k`，b10488 已改成 `--spec-draft-type-k`。
   */
  candidates: string[];
  /** presets.ini 里对应的键名（用于判断该参数是否已被 preset 接管） */
  presetKey?: string;
  /** 值是布尔、但新版参数要求带 on/off 值时，是否允许回退成纯开关 */
  enumValues?: string[];
  /** 说明 / 踩坑提示，GUI 里作为 tooltip */
  hint?: string;
}

// ---------------------------------------------------------------------------
// 启动配置
// ---------------------------------------------------------------------------

/** single = 传统单模型 `-m <path>`；router = `--models-dir` + `--models-preset` 多模型热切换 */
export type ServerMode = "single" | "router";

/** 三态思考开关：off = 直接出答案，on = 开启，auto = 不干预 */
export type ThinkingMode = "off" | "on" | "auto";

/**
 * 启动器配置：一次启动所需的全部输入。
 *
 * 约定：值为 `undefined` / `null` / 空串的字段一律**不**传给 llama-server
 * （让 llama.cpp 用它自己的默认值），而不是传一个"看起来安全"的值。
 * 末尾的索引签名用于保留配置里不认识的额外键，避免丢数据。
 */
export interface LauncherConfig {
  // ---- 运行环境 ----
  /** llama.cpp 构建目录（llama-server.exe 所在目录） */
  llama_dir: string;
  /** 显式指定 exe；留空则用 `<llama_dir>/llama-server.exe` */
  server_exe?: string;

  // ---- 运行模式与模型 ----
  mode?: ServerMode;
  /** single 模式的主模型路径 */
  main_model?: string;
  /** router 模式的模型目录 */
  models_dir?: string;
  /**
   * 模型预设：**配置里直接写成 JSON**（不再依赖外部的 presets.ini）。
   *
   * 形状是「模型名 → 参数表」，键名沿用 llama.cpp `--models-preset` 自己的键
   * （`ctx-size` / `cache-type-k` / `fit-target` / `load-mode` / `threads` / 采样参数…），
   * 因为这张表本质就是"给 llama-server 的参数覆盖表"，启动时由启动器渲染成它认的 ini 再传路径。
   * 键名不做我们自己的翻译，写什么就传什么 —— 免得 llama.cpp 加了新键我们还得跟着改代码。
   *
   * 段名 = 模型名（GGUF 文件名去掉 `.gguf`），与 llama-server 的 `Available models` 一致。
   * 启动器自己的 `default-model` 约定不再放这里 —— 它对应配置里的 {@link LauncherConfig.preload_model}。
   */
  presets?: Record<string, Record<string, string | number | boolean>>;
  /**
   * 旧的 presets.ini 路径，**仅用于导入**。
   *
   * 早先这个路径会被原样传给 `--models-preset`，带来两个麻烦：中文路径会让 llama-server 崩退
   * （必须每次转存到 %TEMP%）、`[defaults]` 段会被服务器当成一个假模型。
   * 现在预设以 {@link LauncherConfig.presets} 为准；这个字段只在 presets 为空时用来做一次性导入。
   */
  models_preset?: string;
  /** router 模式同时加载的模型数上限 */
  models_max?: number | null;
  /** router 模式启动即预加载的模型 ID（GGUF 文件名去掉 .gguf） */
  preload_model?: string;
  /** 多模态投影文件（--mmproj） */
  vision_model?: string;
  /** 草稿模型（推测解码用） */
  draft_model?: string;

  // ---- 服务 ----
  host?: string;
  port?: number;
  api_key?: string;
  alias?: string;
  parallel?: number | null;
  no_webui?: boolean;
  metrics?: boolean;
  log_file?: string;

  // ---- 上下文 / 性能 ----
  context?: number | null;
  /** CPU 线程数；null/-1 = 让 llama.cpp 自己定 */
  threads?: number | null;
  batch_size?: number | null;
  ubatch_size?: number | null;
  /** 显存分层：数字 = 手动指定；"auto" = 交给 --fit 自动算 */
  gpu_layers?: number | string | null;
  fit_target?: number | string | null;
  fit?: string | null;
  fit_ctx?: number | null;
  /** 模型加载模式，如 mmap+mlock */
  load_mode?: string | null;
  /** 旧版锁内存开关（新版权重参数是 --load-mode） */
  mlock?: boolean;
  no_mmap?: boolean;
  no_warmup?: boolean;
  split_mode?: string | null;
  main_gpu?: number | string | null;
  cpu_moe?: boolean;
  cpu_moe_layers?: number | null;

  // ---- KV cache ----
  kv_k_type?: string | null;
  kv_v_type?: string | null;
  flash_attention?: boolean | null;

  // ---- 采样 ----
  temperature?: number | null;
  top_p?: number | null;
  top_k?: number | null;
  min_p?: number | null;
  presence_penalty?: number | null;
  repeat_penalty?: number | null;
  /** 单次生成上限；必须明显小于 context */
  max_predict?: number | null;

  // ---- 思考 / 推理 ----
  think?: ThinkingMode | boolean | null;
  reasoning_effort?: string | null;
  reasoning_budget?: number | null;
  /** 保留思考内容（走独立字段，便于前端折叠显示） */
  reasoning_preserve?: boolean;

  // ---- 工具 ----
  jinja?: boolean;
  tools_all?: boolean;
  agent?: boolean;

  // ---- 推测解码 ----
  spec_enabled?: boolean;
  spec_type?: string | null;
  draft_n?: number | null;
  draft_type_k?: string | null;
  draft_type_v?: string | null;

  // ---- YaRN 长上下文外推 ----
  rope_scaling?: string | null;
  rope_scale?: number | null;
  yarn_orig_ctx?: number | null;

  // ---- 逃逸口 ----
  /** 原样追加的自定义参数 */
  custom_args?: string;
  /** 附加环境变量（命令行盖不住的环境变量走这里） */
  extra_env?: Record<string, string>;

  /** 配置里不认识的额外键：原样保留、不参与拼装 */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 参数拼装结果
// ---------------------------------------------------------------------------

export type StepReason =
  /** 正常由命令行传入 */
  | "cli"
  /** 预加载模式下 preset 对该模型不生效，因此改由命令行直传 */
  | "preload-override"
  /** presets.ini 里定义过，交给 preset 接管，命令行不重复传 */
  | "preset-owned"
  /** 当前 llama.cpp 版本不支持该参数 */
  | "unsupported"
  /** 走了兼容回退分支（如 --fit-target 不可用时退回 -ngl 99） */
  | "fallback"
  /** 有值但按规则不传 */
  | "skipped"
  /** 未配置 */
  | "unset";

/** 每个参数为什么传 / 为什么不传 —— GUI 直接把这些渲染成"参数决策表" */
export interface BuildStep {
  key: string;
  label: string;
  argv: string[];
  reason: StepReason;
  /** 原因的中文说明。由 buildArgs 统一填，避免 CLI 与 GUI 各写一份文案后漂移 */
  reasonLabel: string;
  note: string;
}

export interface BuildInput {
  config: LauncherConfig;
  caps: Capabilities;
  /**
   * presets.ini 里出现过的全部键名（小写）。
   * 默认策略与 llama-oneclick.ps1 一致：收集所有模型段的键做并集 ——
   * 只要某个模型段定义过 ctx-size，命令行就不再传 -c。
   */
  presetKeys?: readonly string[];
  /** 已解析出的预加载模型绝对路径；null = 不预加载 */
  preloadModelFile?: string | null;
  /**
   * single 模式主模型留空时，调用方按 `preload_model` + `models_dir` 推出的路径。
   *
   * 配置里既然写了模型名，就不该再逼用户填一遍完整路径；`buildArgs` 本身不做文件操作，
   * 所以由调用方解析好放进来。
   */
  mainModelFile?: string | null;
  /** 预加载模型在配置预设里的 ctx-size（实测预加载时 preset 不生效，需 CLI 直传） */
  preloadCtxFromPreset?: number | null;
  /**
   * 预加载模型在配置预设里的 `n-predict`（= 单次生成上限）。
   *
   * 与 `preloadCtxFromPreset` 同一个原因：预加载的模型不吃 preset，`-n` 必须由命令行直传；
   * 取该模型自己的推荐值，比用配置级的 `max_predict` 更贴合"按模型给默认值"的用法。
   */
  preloadMaxPredictFromPreset?: number | null;
  /**
   * 真正要传给 `--models-preset` 的路径。
   *
   * 预设存在配置里（JSON），调用方负责把它渲染成 ini 写到临时文件，再把那个路径放这里 ——
   * `buildArgs` 本身不做文件操作，保持纯函数。
   */
  presetArgPath?: string | null;
  /** 是否禁用 GPU（纯 CPU 场景下不再回退 -ngl 99） */
  cpuOnly?: boolean;
}

/**
 * {@link buildArgs} 的返回值。
 *
 * `argv` 与 `steps` 是一一对应的：凡是出现在 argv 里的参数，都能在 steps 里找到
 * 它「为什么被传」；凡是没出现在 argv 里的配置项，也能在 steps 里找到「为什么没传」。
 */
export interface BuildResult {
  argv: string[];
  env: Record<string, string>;
  steps: BuildStep[];
  warnings: string[];
}
