/**
 * 配置读写与归一化。
 *
 * 输入可以是手写的 JSON，也可以对齐 llama-oneclick.ps1 里那套默认值。
 *
 * 归一化阶段做四件容易出错的事：
 *   1. `context: 64` 这类「单位不明」的值要识别出来（见下文注释）；
 *   2. 思考模式与采样默认值联动（Qwen3 两种模式官方给的是两套推荐值，不能混用）；
 *   3. 生成上限必须明显小于 ctx，开了思考还要放宽，否则正文没开始写就被截断；
 *   4. V cache 量化必须有 Flash Attention 撑着，没有就只压 K。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LauncherConfig, ServerMode, ThinkingMode } from "./types.ts";

/** 由 llama.cpp 自己决定的值：直接不传，比人肉猜准 */
export const AUTO = null;

/**
 * 归一化后的默认配置，也是"什么都没配"时的兜底基线。
 *
 * 选值依据：能对齐就对齐既有脚本（`fit_target` / `load_mode` / `kv_*_type` 来自 llama-oneclick.ps1
 * 的实测推荐值），其余交给 llama.cpp 自己的默认值。
 * 采样相关字段刻意留 `null` —— 它们由 {@link normalizeConfig} 按思考模式填两套官方推荐值，
 * 而不是在这里写死一套。
 */
export const DEFAULT_CONFIG: LauncherConfig = {
  llama_dir: "",
  mode: "single",
  host: "127.0.0.1",
  port: 8080,
  context: 32768,
  max_predict: 8192,
  // PS1 的默认值：16G 卡留给系统/桌面的显存余量
  fit_target: 1024,
  load_mode: "mmap+mlock",
  gpu_layers: "auto",
  // 默认压 KV（27B 挤 16G 显存的必需操作），V 侧能否压由 flash_attention 决定
  kv_k_type: "q4_0",
  kv_v_type: "q4_0",
  flash_attention: true,
  think: "off",
  jinja: true,
  // 下面这些留 null：由 normalizeConfig 按思考模式填两套官方推荐值
  temperature: null,
  top_p: null,
  top_k: null,
  min_p: null,
  presence_penalty: null,
  repeat_penalty: null,
  // 留 null：交给 llama.cpp 用物理核数
  threads: null,
  batch_size: null,
  ubatch_size: null,
  parallel: null,
  models_max: null,
  spec_enabled: false,
  mlock: false,
  no_mmap: false,
  no_warmup: false,
  no_webui: false,
  metrics: false,
  tools_all: false,
  agent: false,
  reasoning_preserve: false,
  custom_args: "",
};

/** Qwen3 官方两套推荐采样值（思考 / 非思考不能混用） */
const SAMPLING_BY_THINKING: Record<"on" | "off", Pick<LauncherConfig, "temperature" | "top_p" | "presence_penalty">> = {
  // 思考模式下 presence 给高了会中英混杂
  on: { temperature: 0.6, top_p: 0.95, presence_penalty: 0.5 },
  // 非思考模式，presence 主要用来压复读
  off: { temperature: 0.7, top_p: 0.8, presence_penalty: 1.0 },
};

/**
 * 把「思考模式」的任意写法归一化成三态枚举。
 *
 * 需要它是因为同一个语义在不同来源里写法完全不同：老配置里是 `true/false`，
 * 界面上是 `on/off/auto`，环境变量里可能是 `"yes"`，而 YAML/JSON 里又可能是字符串 `"true"`。
 *
 * 边界：
 * - `undefined` / `null` / 空串 → 返回 `null`，表示**未设置**（调用方应保留默认值或"不干预"）
 * - 无法识别的字符串（如 `"看不懂"`）→ 也返回 `null`，绝不猜一个模式出来
 * - 字符串比较前会 trim 并转小写，`" ON "` 能正确识别
 *
 * @param value 任意来源的原始值
 * @returns `"on"` / `"off"` / `"auto"`；未设置或无法识别时返回 `null`
 */
export function normalizeThink(value: unknown): ThinkingMode | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === true) return "on";
  if (value === false) return "off";
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "on" || v === "true" || v === "yes") return "on";
    if (v === "off" || v === "false" || v === "no") return "off";
    if (v === "auto") return "auto";
  }
  return null;
}

/**
 * 宽松取字符串：只接受非空（trim 后）的字符串，其余一律 `null`。
 *
 * @param v 任意来源的值
 * @returns 原字符串；非字符串或全空白时返回 `null`
 */
function asString(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v;
  return null;
}

/**
 * 宽松取数字：既接受 number，也接受能转成有限数字的字符串
 * （老配置里 `"parallel": "-1"` 就是字符串形态，不能因此丢掉）。
 *
 * 边界：`NaN` / `Infinity` / `""` / 非数字字符串一律 `null`，不会把 NaN 带进后续计算。
 *
 * @param v 任意来源的值
 * @returns 解析出的数字；无法解析时返回 `null`
 */
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * 宽松取布尔，无法判断时返回 `null`（三态，不要把"未知"当成 `false`）。
 *
 * 支持 `"true"/"on"/"yes"/"1"` 与 `"false"/"off"/"no"/"0"`。
 *
 * 边界：**number 形态的 `0` / `1` 不识别**，返回 `null`。
 * 这是故意的：老配置里 `"cpu_moe": 0` 更像"数量"而不是"开关"，
 * 贸然当成 `false` 会改变语义；返回 `null` 时调用方会保留默认值。
 *
 * @param v 任意来源的值
 * @returns 解析出的布尔值；无法判断时返回 `null`
 */
function asBoolOrNull(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "on" || s === "yes" || s === "1") return true;
    if (s === "false" || s === "off" || s === "no" || s === "0") return false;
  }
  return null;
}

/**
 * {@link normalizeConfig} 的返回值。
 *
 * `warnings` 是给用户看的"我替你改了什么/该注意什么"，不含错误级别的问题 ——
 * 归一化永远尽力产出一份可用的配置，而不是抛异常拒绝启动。
 */
export interface NormalizeResult {
  config: LauncherConfig;
  warnings: string[];
}

/**
 * 把任意来源的 JSON 对象归一化成 {@link LauncherConfig}。
 *
 * 输入不需要可信：非对象（`null` / 字符串 / 数字）会被当作空配置处理，
 * 因此垃圾输入不会抛异常，最坏结果是拿到一份全默认配置。
 * **未知键原样保留**（手写的额外键不会被丢掉）。
 *
 * 关键分支（顺序有意义）：
 * 1. **上下文单位识别**：`context` 取值 `1..512` 且未显式声明单位时按「K」解释（64 → 65536），
 *    并明确告警 —— 只识别、不静默改数，用户可以按提示显式声明 `contextUnit`
 * 2. **类型收敛**：数值/布尔/字符串统一走宽松转换，转不出来的保留默认值
 * 3. **模式推断**：显式 `mode` 优先；否则有 `models_dir` 即判为 router
 * 4. **思考模式 → 采样默认值联动**：只填用户**没写过**的字段，
 *    因为 Qwen3 思考/非思考是两套官方推荐值，混用会明显掉质量
 * 5. **生成上限**：开思考时至少放宽到 16384；上限不小于上下文时告警（那样上限等于失效）
 * 6. **V cache 量化依赖 Flash Attention**：FA 关了就退回 `f16`，只压 K（否则量化不生效）
 * 7. **推测解码一致性**：`draft-*` 类型却缺草稿模型时告警
 *
 * @param raw 已 `JSON.parse` 的对象，或任何来源的未知值
 * @returns 归一化后的配置与告警列表；见 {@link NormalizeResult}
 */
export function normalizeConfig(raw: unknown): NormalizeResult {
  const warnings: string[] = [];
  const src: Record<string, unknown> = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: LauncherConfig = { ...DEFAULT_CONFIG, ...src };

  // ---- 上下文长度单位 ----
  // 有人沿用了「K」的写法：`"context": 64` 表示 64K。而 llama-server 的 -c 收的是 token 数
  // （16K 档位在 PS1 里写的是 32768），1..512 这个区间不可能是 token 数。这里只做识别 + 明确告警，
  // 不静默改数。
  const ctxRaw = asNumber(src["context"]);
  if (ctxRaw !== null && ctxRaw > 0 && ctxRaw <= 512 && src["contextUnit"] === undefined) {
    const tokens = ctxRaw * 1024;
    out.context = tokens;
    warnings.push(
      `配置里的 context=${ctxRaw} 小于等于 512，按「K」解释为 ${tokens} tokens。` +
        `若你原本就想要 ${ctxRaw} tokens，请把 context 显式改成 ${ctxRaw} 并加 "contextUnit": "tokens"`,
    );
  }

  // ---- 数值/开关类型收敛 ----
  out.port = asNumber(src["port"]) ?? DEFAULT_CONFIG.port;
  out.host = asString(src["host"]) ?? DEFAULT_CONFIG.host;
  out.threads = asNumber(src["threads"]) ?? DEFAULT_CONFIG.threads;
  out.context = out.context === null ? null : asNumber(out.context);
  out.max_predict = asNumber(src["max_predict"]) ?? DEFAULT_CONFIG.max_predict;
  out.fit_target = asNumber(src["fit_target"]) ?? asString(src["fit_target"]) ?? DEFAULT_CONFIG.fit_target;
  out.fit_ctx = asNumber(src["fit_ctx"]);
  out.batch_size = asNumber(src["batch_size"]);
  out.ubatch_size = asNumber(src["ubatch_size"]);
  out.parallel = asNumber(src["parallel"]);
  out.models_max = asNumber(src["models_max"]);
  out.draft_n = asNumber(src["draft_n"]);
  out.reasoning_budget = asNumber(src["reasoning_budget"]);
  out.reasoning_effort = asString(src["reasoning_effort"]);
  out.rope_scale = asNumber(src["rope_scale"]);
  out.yarn_orig_ctx = asNumber(src["yarn_orig_ctx"]);
  out.cpu_moe_layers = asNumber(src["cpu_moe_layers"]);
  out.main_gpu = asString(src["main_gpu"]) ?? asNumber(src["main_gpu"]) ?? null;

  for (const key of [
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "presence_penalty",
    "repeat_penalty",
  ] as const) {
    out[key] = asNumber(src[key]);
  }

  for (const key of [
    "jinja",
    "tools_all",
    "agent",
    "mlock",
    "no_mmap",
    "no_warmup",
    "no_webui",
    "metrics",
    "reasoning_preserve",
    "spec_enabled",
    "cpu_moe",
  ] as const) {
    const b = asBoolOrNull(src[key]);
    if (b !== null) out[key] = b;
  }

  const fa = asBoolOrNull(src["flash_attention"]);
  if (fa !== null) out.flash_attention = fa;

  out.think = normalizeThink(src["think"]) ?? DEFAULT_CONFIG.think;

  // ---- 模式推断 ----
  const explicitMode = asString(src["mode"]);
  const mode: ServerMode = explicitMode === "router" || explicitMode === "single"
    ? explicitMode
    : asString(src["models_dir"])
      ? "router"
      : "single";
  out.mode = mode;

  // ---- 思考模式 → 采样默认值联动（用户显式写过的值不覆盖）----
  const thinkingKey: "on" | "off" = out.think === "on" ? "on" : "off";
  const presetSampling = SAMPLING_BY_THINKING[thinkingKey];
  if (src["temperature"] === undefined) out.temperature = presetSampling.temperature;
  if (src["top_p"] === undefined) out.top_p = presetSampling.top_p;
  if (src["presence_penalty"] === undefined) out.presence_penalty = presetSampling.presence_penalty;
  if (src["top_k"] === undefined) out.top_k = 20;
  if (src["min_p"] === undefined) out.min_p = 0;

  // ---- 生成上限：开思考要放宽，否则 token 全花在 <think> 里 ----
  if (out.think === "on" && typeof out.max_predict === "number" && out.max_predict < 16384) {
    warnings.push(`思考模式已开启，生成上限由 ${out.max_predict} 放宽到 16384（否则正文还没开始写就被截断）`);
    out.max_predict = 16384;
  }
  if (typeof out.max_predict === "number" && typeof out.context === "number" && out.context > 0 && out.max_predict >= out.context) {
    warnings.push(`生成上限 ${out.max_predict} 不小于上下文 ${out.context}，上限会失效（上下文先被撑满）`);
  }

  // ---- V cache 量化必须有 Flash Attention 撑着 ----
  const vType = asString(src["kv_v_type"]) ?? DEFAULT_CONFIG.kv_v_type ?? null;
  if (vType && vType !== "f16" && out.flash_attention === false) {
    out.kv_v_type = "f16";
    warnings.push(`V cache 量化（${vType}）依赖 Flash Attention，当前已关闭，V cache 退回 f16，只压 K`);
  }

  // ---- 推测解码一致性 ----
  if (out.spec_type && !out.draft_model && /^draft-/.test(String(out.spec_type))) {
    warnings.push(`spec_type=${out.spec_type} 需要草稿模型，但未配置 draft_model`);
  }

  return { config: out, warnings };
}

/**
 * 读配置文件并归一化。
 *
 * @param path 配置文件路径
 * @returns 归一化后的配置与告警，见 {@link NormalizeResult}
 * @throws {Error} 文件不存在或不可读时由 `readFileSync` 抛出（`ENOENT` / `EPERM` 等）；
 *   JSON 语法错误时由 `JSON.parse` 抛出 `SyntaxError`。
 *   调用方若要"读不到就退回默认值"，请先自行判断 `existsSync`
 */
export function loadConfigFile(path: string): NormalizeResult {
  const text = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  return normalizeConfig(parsed);
}

/**
 * 保存配置到磁盘。
 *
 * 两个刻意为之的细节：
 * 1. **UTF-8 且不带 BOM** —— BOM 会让下游（llama-server 读 presets.ini 时）直接解析失败，
 *    这里踩过一次坑，因此不用第三方写库、直接交给 Node；
 * 2. **键顺序稳定**：先按 `preferred` 列表输出，再把剩下的键追加在后面。
 *    这样同一份配置反复保存不会产生满屏无意义的 diff，人肉 review 也舒服。
 *
 * 值为 `undefined` 的字段会被跳过（不写出 `"key": null` 这种噪音）；
 * 保留下来的 `null` 是有意义的，表示"交给 llama.cpp 自己决定"。
 *
 * @param path 目标路径，所在目录必须已存在
 * @param config 要保存的配置（通常是归一化后的结果）
 * @throws {Error} 目录不存在或没有写权限时由 `writeFileSync` 抛出（`ENOENT` / `EPERM`）
 */
export function saveConfigFile(path: string, config: LauncherConfig): void {
  const ordered: Record<string, unknown> = {};
  const preferred = [
    "llama_dir",
    "server_exe",
    "mode",
    "main_model",
    "models_dir",
    "models_preset",
    "models_max",
    "preload_model",
    "vision_model",
    "draft_model",
    "host",
    "port",
    "api_key",
    "alias",
    "parallel",
    "context",
    "max_predict",
    "threads",
    "batch_size",
    "ubatch_size",
    "gpu_layers",
    "fit",
    "fit_target",
    "fit_ctx",
    "load_mode",
    "kv_k_type",
    "kv_v_type",
    "flash_attention",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "presence_penalty",
    "repeat_penalty",
    "think",
    "reasoning_effort",
    "reasoning_budget",
    "reasoning_preserve",
    "jinja",
    "tools_all",
    "agent",
    "spec_enabled",
    "spec_type",
    "draft_n",
    "draft_type_k",
    "draft_type_v",
    "rope_scaling",
    "rope_scale",
    "yarn_orig_ctx",
    "custom_args",
  ];
  for (const key of preferred) {
    if (config[key] !== undefined) ordered[key] = config[key];
  }
  for (const [key, value] of Object.entries(config)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

/**
 * 推出 llama-server.exe 的路径。
 *
 * 只做字符串拼接，**不检查文件是否存在**（存在性判断留给调用方，
 * 因为"配了但文件不在"是需要展示给用户的告警，而不是这里直接返回空）。
 *
 * @param config 启动配置
 * @returns `server_exe` 优先；否则用 `<llama_dir>/llama-server.exe`；
 *   两者都没配时返回**空串**（调用方应据此走自动探测，而不是拿空串去 spawn）
 */
export function resolveServerExe(config: LauncherConfig): string {
  if (config.server_exe) return config.server_exe;
  if (!config.llama_dir) return "";
  return join(config.llama_dir, "llama-server.exe");
}

/**
 * 探测 llama.cpp 构建目录（`llama-server.exe` 所在目录）。
 *
 * 查找顺序（逐级放宽，找到即返回）：
 * 1. 环境变量 `LLAMA_SERVER`：直接指向 exe，取其所在目录
 * 2. 环境变量 `LLAMA_DIR`
 * 3. 对每个起点目录**向上回溯最多 `maxUpLevels` 层**，每层检查「该层本身」与「该层的 `llama.cpp/`」
 *
 * 第 3 条为什么要向上回溯：打包后的便携版，exe 在
 * `<项目>\llama-launcher\dist\win-unpacked\`，而 llama.cpp 在 `<项目>\llama.cpp\` ——
 * 中间隔着三层目录。只查"自己 / 自己下面 / 上一级"会漏掉这种常见布局，
 * 于是首次运行生成的配置里 `llama_dir` 是空的（踩过，用户看到的现象就是它）。
 *
 * 判断依据始终是「该目录下存在 `llama-server.exe`」，不做更聪明的猜测。
 *
 * @param startDirs 起点目录列表，按顺序尝试（打包时把 exe 目录放最前，其次 cwd）
 * @param env 环境变量来源，默认 `process.env`；测试时可注入
 * @param maxUpLevels 每个起点最多向上回溯几层，默认 3
 * @returns 探测到的目录**绝对路径**；全部落空时返回 `null`
 */
export function discoverLlamaDir(
  startDirs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  maxUpLevels = 3,
): string | null {
  const explicitExe = env["LLAMA_SERVER"];
  if (explicitExe && existsSync(explicitExe)) return dirname(explicitExe);

  const explicitDir = env["LLAMA_DIR"];
  if (explicitDir && existsSync(join(explicitDir, "llama-server.exe"))) return resolve(explicitDir);

  for (const start of startDirs) {
    let current = resolve(start);
    for (let level = 0; level <= maxUpLevels; level += 1) {
      for (const candidate of [current, join(current, "llama.cpp")]) {
        if (existsSync(join(candidate, "llama-server.exe"))) return candidate;
      }
      const parent = dirname(current);
      if (parent === current) break; // 已经到盘根，别再往上
      current = parent;
    }
  }
  return null;
}
