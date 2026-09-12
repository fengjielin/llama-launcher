/**
 * 配置读写与归一化。
 *
 * 兼容目标：能直接吃 llamaServer启动器v1.9（PyQt6 原版）写出的
 * `llama_launcher_config.json`，以及 llama-oneclick.ps1 里那套默认值。
 *
 * 归一化阶段做四件容易出错的事：
 *   1. v1.9 的 `context: 64` 这类「单位不明」的值要识别出来（见下文注释）；
 *   2. 思考模式与采样默认值联动（Qwen3 两种模式官方给的是两套推荐值，不能混用）；
 *   3. 生成上限必须明显小于 ctx，开了思考还要放宽，否则正文没开始写就被截断；
 *   4. V cache 量化必须有 Flash Attention 撑着，没有就只压 K。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LauncherConfig, ServerMode, ThinkingMode } from "./types.ts";

/** 由 llama.cpp 自己决定的值：直接不传，比人肉猜准 */
export const AUTO = null;

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

function asString(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v;
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asBoolOrNull(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "on" || s === "yes" || s === "1") return true;
    if (s === "false" || s === "off" || s === "no" || s === "0") return false;
  }
  return null;
}

export interface NormalizeResult {
  config: LauncherConfig;
  warnings: string[];
}

/**
 * 把任意来源的 JSON 对象归一化成 LauncherConfig。
 * 未知键原样保留（迁移 v1.9 配置时不丢数据）。
 */
export function normalizeConfig(raw: unknown): NormalizeResult {
  const warnings: string[] = [];
  const src: Record<string, unknown> = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: LauncherConfig = { ...DEFAULT_CONFIG, ...src };

  // ---- v1.9 专有键迁移 ----
  const isV19 = "推测技术" in src || "mcp_proxy" in src || "cpu_threads" in src;
  if (isV19) {
    const migratedThreads = asNumber(src["cpu_threads"]);
    if (migratedThreads !== null) out.threads = migratedThreads;
    const migratedSpec = asBoolOrNull(src["推测技术"]);
    if (migratedSpec !== null) out.spec_enabled = migratedSpec;
    warnings.push("检测到 v1.9 格式配置，已迁移（cpu_threads → threads，推测技术 → spec_enabled，未知键保留）");
    if (src["mcp_proxy"] !== undefined) {
      warnings.push("v1.9 的 MCP 代理开关暂无对应实现，已原样保留在配置里，未传给 llama-server");
    }
  }

  // ---- 上下文长度单位 ----
  // v1.9 的配置里写的是 "context": 64。llama-server 的 -c 是 token 数（16K 档位在 PS1 里是
  // 32768），64 不可能是 token 数，按「K」解释（64K = 65536）。这里只做识别 + 明确告警，
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
  // 注意 ?? 的顺序：v1.9 的 cpu_threads 已在上面迁移进 out.threads，
  // 这里 src["threads"] 不存在时不能把迁移结果冲掉
  out.threads = asNumber(src["threads"]) ?? asNumber(out.threads);
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

export function loadConfigFile(path: string): NormalizeResult {
  const text = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  return normalizeConfig(parsed);
}

/** 保存配置。UTF-8 且不带 BOM（presets.ini 踩过 BOM 会让 llama-server 解析失败的坑） */
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

export function resolveServerExe(config: LauncherConfig): string {
  if (config.server_exe) return config.server_exe;
  if (!config.llama_dir) return "";
  return join(config.llama_dir, "llama-server.exe");
}

/**
 * 探测 llama.cpp 构建目录。顺序与 llama-oneclick.ps1 一致：
 * 环境变量 → 给定起点目录 → 起点目录下的 llama.cpp → 起点的上一级 llama.cpp
 */
export function discoverLlamaDir(startDirs: readonly string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const explicitExe = env["LLAMA_SERVER"];
  if (explicitExe && existsSync(explicitExe)) return dirname(explicitExe);

  const explicitDir = env["LLAMA_DIR"];
  if (explicitDir && existsSync(join(explicitDir, "llama-server.exe"))) return resolve(explicitDir);

  for (const start of startDirs) {
    const candidates = [start, join(start, "llama.cpp"), join(start, "..", "llama.cpp")];
    for (const dir of candidates) {
      if (existsSync(join(dir, "llama-server.exe"))) return resolve(dir);
    }
  }
  return null;
}
