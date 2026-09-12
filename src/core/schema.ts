/**
 * 声明式参数表 —— 全程序关于「llama-server 有哪些参数、叫什么名字」的唯一真源。
 *
 * GUI 的表单、命令行拼装、preset 占位判断三者都读这一张表，
 * 避免把参数知识散进 UI 代码（llama.cpp 参数改动频繁，散着写必然腐化）。
 *
 * 设计要点：
 *   1. `candidates` 按优先级列出同一语义在不同版本里的全部名字，运行时由
 *      `caps.pick()` 挑第一个当前版本支持的 —— 版本回退不需要改代码。
 *   2. `presetKey` 指向 presets.ini 里的键名。preset 与命令行是两套配置源，
 *      实测命令行优先级更高，所以 preset 里定义过的键命令行不能再传，否则会盖掉。
 *
 * 表中所有参数名都在 fixtures/help-b10488.txt 里核实过存在。
 */

import type { ParamGroup, ParamSpec } from "./types.ts";

/** 参数分组及展示顺序 —— GUI 的参数表单按这个顺序折叠成分节 */
export const PARAM_GROUPS: readonly { id: ParamGroup; label: string }[] = [
  { id: "model", label: "模型与模式" },
  { id: "server", label: "服务与网络" },
  { id: "context", label: "上下文与批处理" },
  { id: "perf", label: "显存与性能" },
  { id: "sampling", label: "采样" },
  { id: "spec", label: "KV cache 与推测解码" },
  { id: "reasoning", label: "思考 / 推理" },
  { id: "tools", label: "工具与前端" },
  { id: "misc", label: "其它" },
];

/**
 * 参数表本体：启动器认识的全部 llama-server 参数。
 *
 * 维护约定（新增/调整参数时只改这一处即可）：
 * - 新参数的 **CLI 名字按优先级写进 `candidates`**，把新名放前面、旧名放后面，
 *   运行时由 `caps.pick()` 挑第一个当前版本支持的，于是版本回退不需要写 if
 * - 若该参数在 presets.ini 里也有同名配置，必须填 `presetKey`，
 *   否则会出现"命令行把 preset 盖掉"的隐蔽 bug
 * - `hint` 里写踩坑提示，它会作为 GUI 的 tooltip 显示
 *
 * 表中所有参数名都在 `fixtures/help-b10488.txt` 里核实过真实存在。
 */
export const PARAM_SPECS: readonly ParamSpec[] = [
  // ---------------------------------------------------------------- 模型与模式
  {
    key: "main_model",
    label: "主模型",
    group: "model",
    kind: "string",
    candidates: ["-m", "--model"],
    hint: "single 模式下的主 GGUF 路径",
  },
  {
    key: "models_dir",
    label: "模型目录",
    group: "model",
    kind: "string",
    candidates: ["--models-dir"],
    hint: "router 模式：目录里的模型可在网页左上角随时切换，无需重启",
  },
  {
    key: "models_preset",
    label: "模型预设文件",
    group: "model",
    kind: "string",
    candidates: ["--models-preset"],
    hint: "旧字段：仅在导入 presets.ini 时写入作参考；实际预设以配置里的 presets 字段为准",
  },
  {
    key: "models_max",
    label: "同时加载模型数",
    group: "model",
    kind: "int",
    candidates: ["--models-max"],
  },
  {
    key: "preload_model",
    label: "启动预加载模型",
    group: "model",
    kind: "string",
    candidates: ["--model"],
    hint: "预加载会把 --model 直接喂给 router server；实测此时 preset 对该模型不生效",
  },
  {
    key: "vision_model",
    label: "视觉投影文件",
    group: "model",
    kind: "string",
    candidates: ["-mm", "--mmproj"],
  },
  {
    key: "draft_model",
    label: "草稿模型",
    group: "model",
    kind: "string",
    candidates: ["--spec-draft-model", "-md", "--model-draft"],
    hint: "推测解码用的草稿模型；b10488 起改名为 --spec-draft-model（旧名 --model-draft）",
  },

  // ---------------------------------------------------------------- 服务与网络
  { key: "host", label: "监听地址", group: "server", kind: "string", candidates: ["--host"] },
  { key: "port", label: "端口", group: "server", kind: "int", candidates: ["--port"] },
  { key: "api_key", label: "API Key", group: "server", kind: "string", candidates: ["--api-key"] },
  { key: "alias", label: "模型别名", group: "server", kind: "string", candidates: ["--alias"] },
  { key: "parallel", label: "并发槽位", group: "server", kind: "int", candidates: ["-np", "--parallel"] },
  { key: "log_file", label: "日志文件", group: "server", kind: "string", candidates: ["--log-file"] },
  { key: "no_webui", label: "禁用内置 WebUI", group: "server", kind: "bool", candidates: ["--no-webui"] },
  { key: "metrics", label: "暴露 Prometheus 指标", group: "server", kind: "bool", candidates: ["--metrics"] },

  // ---------------------------------------------------------------- 上下文与批处理
  {
    key: "context",
    label: "上下文长度",
    group: "context",
    kind: "int",
    candidates: ["-c", "--ctx-size"],
    presetKey: "ctx-size",
    hint: "ctx 翻倍 KV cache 也翻倍；16G 显存跑 27B 建议 16384 起",
  },
  {
    key: "max_predict",
    label: "单次生成上限",
    group: "context",
    kind: "int",
    candidates: ["-n", "--predict", "--n-predict"],
    presetKey: "n-predict",
    hint: "llama-server 默认 -1（无限），模型复读时会吃满上下文卡死，必须给硬上限。网页设置里的 max tokens 会覆盖它，两边都要设",
  },
  { key: "batch_size", label: "逻辑批大小", group: "context", kind: "int", candidates: ["-b", "--batch-size"] },
  { key: "ubatch_size", label: "物理批大小", group: "context", kind: "int", candidates: ["-ub", "--ubatch-size"] },
  { key: "rope_scaling", label: "RoPE 缩放方式", group: "context", kind: "enum", candidates: ["--rope-scaling"], enumValues: ["none", "linear", "yarn"] },
  { key: "rope_scale", label: "RoPE 缩放系数", group: "context", kind: "float", candidates: ["--rope-scale"] },
  {
    key: "yarn_orig_ctx",
    label: "YaRN 原始上下文",
    group: "context",
    kind: "int",
    candidates: ["--yarn-orig-ctx"],
    hint: "有些 GGUF 已把 YaRN 烤进 metadata，重复设置反而出问题",
  },

  // ---------------------------------------------------------------- 显存与性能
  {
    key: "threads",
    label: "CPU 线程数",
    group: "perf",
    kind: "int",
    candidates: ["-t", "--threads"],
    presetKey: "threads",
    hint: "留空由 llama.cpp 自己定（默认物理核数），比人肉猜准",
  },
  {
    key: "gpu_layers",
    label: "显存分层数",
    group: "perf",
    kind: "string",
    candidates: ["-ngl", "--gpu-layers", "--n-gpu-layers"],
    presetKey: "n-gpu-layers",
    hint: "填 auto 交给 --fit 实测显存后自动分层（比人肉试准）；填数字则手动指定",
  },
  { key: "fit", label: "自动适配显存", group: "perf", kind: "enum", candidates: ["-fit", "--fit"], enumValues: ["on", "off"] },
  {
    key: "fit_target",
    label: "显存余量目标",
    group: "perf",
    kind: "string",
    candidates: ["--fit-target", "-fitt"],
    presetKey: "fit-target",
    hint: "留给系统/桌面的显存余量（MiB），值越小模型上卡越多；16G 卡留 1024 通常够稳，激进可试 512",
  },
  { key: "fit_ctx", label: "fit 最小 ctx", group: "perf", kind: "int", candidates: ["-fitc", "--fit-ctx"] },
  {
    key: "load_mode",
    label: "模型加载模式",
    group: "perf",
    kind: "string",
    candidates: ["--load-mode", "-lm"],
    presetKey: "load-mode",
    hint: "mmap+mlock 可避免 Windows 把模型页换到磁盘导致速度暴跌",
  },
  {
    key: "mlock",
    label: "锁内存（旧参数）",
    group: "perf",
    kind: "bool",
    candidates: ["--mlock"],
    hint: "b10488 已标 DEPRECATED，改用 --load-mode；仅在旧版本回退时使用",
  },
  { key: "no_mmap", label: "禁用内存映射", group: "perf", kind: "bool", candidates: ["--no-mmap"] },
  { key: "split_mode", label: "多卡切分方式", group: "perf", kind: "string", candidates: ["--split-mode"] },
  { key: "main_gpu", label: "主显卡编号", group: "perf", kind: "string", candidates: ["--main-gpu"] },
  { key: "cpu_moe", label: "MoE 权重全放 CPU", group: "perf", kind: "bool", candidates: ["-cmoe", "--cpu-moe"] },
  { key: "cpu_moe_layers", label: "前 N 层 MoE 放 CPU", group: "perf", kind: "int", candidates: ["-ncmoe", "--n-cpu-moe"] },
  { key: "no_warmup", label: "跳过预热", group: "perf", kind: "bool", candidates: ["--no-warmup"] },

  // ---------------------------------------------------------------- 采样
  { key: "temperature", label: "温度", group: "sampling", kind: "float", candidates: ["--temp"], presetKey: "temperature" },
  { key: "top_p", label: "top-p", group: "sampling", kind: "float", candidates: ["--top-p"], presetKey: "top-p" },
  { key: "top_k", label: "top-k", group: "sampling", kind: "int", candidates: ["--top-k"], presetKey: "top-k" },
  { key: "min_p", label: "min-p", group: "sampling", kind: "float", candidates: ["--min-p"], presetKey: "min-p" },
  {
    key: "presence_penalty",
    label: "存在惩罚",
    group: "sampling",
    kind: "float",
    candidates: ["--presence-penalty"],
    presetKey: "presence-penalty",
    hint: "Qwen3 思考模式给高了会中英混杂",
  },
  { key: "repeat_penalty", label: "重复惩罚", group: "sampling", kind: "float", candidates: ["--repeat-penalty"], presetKey: "repeat-penalty" },

  // ---------------------------------------------------------------- KV cache 与推测解码
  {
    key: "kv_k_type",
    label: "K cache 量化",
    group: "spec",
    kind: "string",
    candidates: ["--cache-type-k"],
    presetKey: "cache-type-k",
  },
  {
    key: "kv_v_type",
    label: "V cache 量化",
    group: "spec",
    kind: "string",
    candidates: ["--cache-type-v"],
    presetKey: "cache-type-v",
    hint: "V cache 量化必须有 Flash Attention 撑着，否则不生效",
  },
  {
    key: "flash_attention",
    label: "Flash Attention",
    group: "spec",
    kind: "bool",
    candidates: ["-fa", "--flash-attn"],
    presetKey: "flash-attn",
    hint: "新版是 -fa on/off/auto，旧版是纯开关，拼装时按 help 探测结果自动选形式",
  },
  {
    key: "spec_type",
    label: "推测解码类型",
    group: "spec",
    kind: "string",
    candidates: ["--spec-type"],
    hint: "b10488 支持 none / draft-simple / draft-eagle3 / draft-mtp / draft-dflash / draft-dspark / ngram-*",
  },
  { key: "draft_n", label: "草稿 token 数", group: "spec", kind: "int", candidates: ["--spec-draft-n-max", "--draft-n", "--draft-max"] },
  {
    key: "draft_type_k",
    label: "草稿 K cache 量化",
    group: "spec",
    kind: "string",
    candidates: ["--spec-draft-type-k", "-ctkd", "--cache-type-k-draft", "--draft-type-k"],
  },
  {
    key: "draft_type_v",
    label: "草稿 V cache 量化",
    group: "spec",
    kind: "string",
    candidates: ["--spec-draft-type-v", "-ctvd", "--cache-type-v-draft", "--draft-type-v"],
  },

  // ---------------------------------------------------------------- 思考 / 推理
  {
    key: "think",
    label: "思考模式",
    group: "reasoning",
    kind: "enum",
    candidates: ["--reasoning"],
    enumValues: ["on", "off", "auto"],
    hint: "新版用 --reasoning on/off/auto；旧版回退 --reasoning-budget + LLAMA_ARG_CHAT_TEMPLATE_KWARGS",
  },
  {
    key: "reasoning_effort",
    label: "思考强度",
    group: "reasoning",
    kind: "string",
    candidates: ["--reasoning-effort"],
    hint: "交给 chat template 的思考强度，'default' = 用模型默认",
  },
  {
    key: "reasoning_budget",
    label: "思考预算",
    group: "reasoning",
    kind: "int",
    candidates: ["--reasoning-budget"],
    presetKey: "reasoning-budget",
    hint: "0 = 立刻掐掉思考；-1 = 不限",
  },
  {
    key: "reasoning_preserve",
    label: "保留思考内容",
    group: "reasoning",
    kind: "bool",
    candidates: ["--reasoning-format"],
    hint: "思考内容走独立字段便于前端折叠显示（auto）",
  },

  // ---------------------------------------------------------------- 工具与前端
  {
    key: "jinja",
    label: "启用 Jinja 模板",
    group: "tools",
    kind: "bool",
    candidates: ["--jinja"],
    hint: "正确套用模型自带对话模板 + 工具调用，建议常开",
  },
  {
    key: "tools_all",
    label: "启用全部内置工具",
    group: "tools",
    kind: "bool",
    candidates: ["--tools"],
    hint: "experimental：会放开文件读写/grep 等工具，不要在不可信环境开",
  },
  {
    key: "agent",
    label: "Agent 模式",
    group: "tools",
    kind: "bool",
    candidates: ["--agent", "-ag"],
    hint: "启用 CORS 代理 + 全部内置工具",
  },
  { key: "custom_args", label: "自定义参数", group: "misc", kind: "string", candidates: [] },
];

/** 配置键 → 参数定义，供界面按字段名反查；键与 {@link ParamSpec.key} 一致 */
export const PARAM_BY_KEY: Map<string, ParamSpec> = new Map(PARAM_SPECS.map((s) => [s.key, s]));

/**
 * 按配置键取参数定义。
 *
 * @param key 配置键名（如 `context`、`kv_k_type`）
 * @returns 对应的参数定义；键不在表中时返回 `undefined`（不抛异常）
 */
export function specForKey(key: string): ParamSpec | undefined {
  return PARAM_BY_KEY.get(key);
}

/**
 * 拿当前版本能力逐条解析参数表，回答"这个参数能不能用、实际用哪个名字"。
 *
 * 与 `summarizeCapabilities` 的区别：那个是给"环境自检"看的汇总统计，
 * 这个保留每一条的完整信息，供 GUI 逐项渲染（不支持的置灰、改名后显示实际名字）。
 *
 * @param caps 能力视图，只用到 `pick()` 一个方法（便于测试里注入假的实现）
 * @returns 与 {@link PARAM_SPECS} 等长、顺序一致的数组；
 *   无候选名的参数（如自定义参数）`supported` 恒为 `true`、`resolvedFlag` 为 `null`
 */
export function resolveSpecs(
  caps: { pick(candidates: readonly string[]): string | null },
): { spec: ParamSpec; supported: boolean; resolvedFlag: string | null }[] {
  return PARAM_SPECS.map((spec) => {
    if (spec.candidates.length === 0) return { spec, supported: true, resolvedFlag: null };
    const resolvedFlag = caps.pick(spec.candidates);
    return { spec, supported: resolvedFlag !== null, resolvedFlag };
  });
}
