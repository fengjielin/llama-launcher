/**
 * 命令行拼装 —— core 的核心，纯函数、无副作用、可单测。
 *
 * 设计原则：
 *   1. 每一步都产出「为什么传 / 为什么不传」的决策记录（BuildStep），
 *      GUI 直接把这张表渲染出来，用户就不会再问"我明明配了为什么没生效"。
 *   2. 参数名一律走 `caps.pick(candidates)`，版本不支持就走回退分支或明确告警，
 *      绝不静默变成一个语义完全不同的启动方式（例如悄悄退化成纯 CPU 推理）。
 *   3. 与 presets.ini 的关系照 llama-oneclick.ps1 的实测结论：
 *      preset 里定义过的键命令行不再传（命令行优先级更高，会盖掉 preset）；
 *      但预加载模式下 preset 对该模型不生效，此时必须改由命令行直传。
 *
 * 装配顺序与 llama-oneclick.ps1 保持一致，便于逐项对拍。
 */

import { normalizeThink } from "./config.ts";
import type { BuildInput, BuildResult, BuildStep, ServerMode, StepReason } from "./types.ts";

/**
 * 思考开关回退方案用的环境变量名。
 *
 * 不用命令行传 `--chat-template-kwargs` 的原因（实测踩过）：Windows 下 PowerShell
 * 把带双引号的 JSON 传给原生 exe 时会把引号剥掉，JSON 就成了非法参数；
 * llama.cpp 本身读这个环境变量，走它更稳。
 */
export const CHAT_TEMPLATE_KWARGS_ENV = "LLAMA_ARG_CHAT_TEMPLATE_KWARGS";

/**
 * 把「自定义参数」文本切成 argv 数组。
 *
 * 支持单双引号包裹（`--alias "my model"`），引号内的空白不作为分隔符
 * —— 否则带空格的模型别名会被切成两个参数。
 *
 * 边界：
 * - 引号未闭合时，剩余内容整体作为最后一个参数（不报错，尽量让用户启动成功）
 * - 空串、纯空白返回空数组
 * - 连续空白不会产出空参数；`""` 这种显式空串会被保留为一个空参数
 *
 * @param input 用户填写的自定义参数字符串
 * @returns 参数数组，顺序与输入一致
 */
export function splitCustomArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let hadQuote = false;
  for (const ch of input) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hadQuote = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== "" || hadQuote) out.push(cur);
      cur = "";
      hadQuote = false;
      continue;
    }
    cur += ch;
  }
  if (cur !== "" || hadQuote) out.push(cur);
  return out;
}

/**
 * 把 argv 数组拼成**给人看/给人复制**的一行命令，含空格的参数会补上双引号。
 *
 * 注意这只是展示用途：真正 spawn 子进程时应当直接传数组
 * （Node 会自己处理参数边界），不要把这里的结果再切回数组。
 *
 * @param argv 参数数组
 * @returns 单行命令字符串（不含可执行文件路径本身）
 */
export function formatArgv(argv: readonly string[]): string {
  return argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

const REASON_LABEL: Record<StepReason, string> = {
  cli: "命令行直传",
  "preload-override": "预加载直传",
  "preset-owned": "preset 接管",
  unsupported: "版本不支持",
  fallback: "兼容回退",
  skipped: "按规则跳过",
  unset: "未配置",
};

/**
 * 取「原因」的中文文案。
 *
 * 决策表里每一行都要显示原因，而 GUI 是通过 IPC 拿数据的、CLI 是直接调用的，
 * 所以文案统一由这里提供（随 `BuildStep.reasonLabel` 一起下发），避免两边各写一份后漂移。
 *
 * @param reason 原因枚举
 * @returns 对应的中文说明
 */
export function reasonLabel(reason: StepReason): string {
  return REASON_LABEL[reason];
}

/**
 * 计算字符串在终端里的显示宽度：全角字符按 2 列算。
 *
 * 用途是给决策表对齐列 —— 中文按 1 个字符长度算的话，表格会参差不齐。
 * 只覆盖常见的宽字符区间（CJK、全角符号、韩文），不做完整的 Unicode East Asian Width 表。
 *
 * @param text 待测文本
 * @returns 显示宽度（列数）
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * 按显示宽度右侧补空格（中文按 2 列算），用于终端表格对齐。
 *
 * @param text 待补齐的文本
 * @param width 目标显示宽度；文本已超宽时不截断，原样返回
 * @returns 补好空格的文本
 */
function padDisplay(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * 把决策表渲染成人类可读的定宽表格（CLI 打印用；GUI 用同一份数据自行排版）。
 *
 * 每行四列：原因 / 参数名 / 实际传入的片段 / 说明。列宽按最长内容自适应，
 * 中文按 2 列宽计算以免错位。
 *
 * @param steps {@link buildArgs} 产出的决策记录
 * @returns 多行字符串；`steps` 为空时返回空串
 */
export function describeSteps(steps: readonly BuildStep[]): string {
  const lines: string[] = [];
  const labelWidth = Math.max(...steps.map((s) => displayWidth(s.label)), 4);
  const reasonWidth = Math.max(...Object.values(REASON_LABEL).map((s) => displayWidth(s)));
  for (const s of steps) {
    const arg = s.argv.length > 0 ? formatArgv(s.argv) : "-";
    lines.push(
      `${padDisplay(s.reasonLabel, reasonWidth)} | ${padDisplay(s.label, labelWidth)} | ${arg} | ${s.note}`,
    );
  }
  return lines.join("\n");
}

/** `emit` 的入参：描述"一个配置项该怎么变成命令行参数" */
interface EmitOptions {
  key: string;
  label: string;
  candidates: readonly string[];
  value: unknown;
  presetKey?: string;
  /** 预加载模式下允许绕过 preset 占位（实测预加载的模型不吃 preset） */
  preloadBypass?: boolean;
  /** 返回 null = 只传开关名；返回字符串 = 传值 */
  render?: (flag: string, value: unknown) => string | null;
  /** 返回非空说明 = 主动跳过 */
  skipWhen?: (value: unknown) => string | null;
  reasonOverride?: StepReason;
  note?: string;
  warning?: string;
}

/**
 * 拼装最终的 llama-server 命令行。
 *
 * 这是整个 core 的核心，且是**纯函数**：不读文件、不起进程、不访问网络，
 * 因此同一份配置在任何环境下都会得到同一条命令行（GUI 与 CLI 靠这一点保持一致），
 * 也正因如此才能用单测逐字节对拍。
 *
 * 每个参数的处理都遵循同一套判定顺序（由内部的 `emit` 实现）：
 * 1. 值为 `undefined`/`null`/空串 → 记 `unset`，**不传给 llama.cpp**（用它的默认值）
 * 2. `skipWhen` 判定为"无需传"（如 `-1` 表示自动）→ 记 `skipped`
 * 3. presets.ini 里定义过同名键 → 记 `preset-owned`，命令行**不传**
 *    （实测命令行优先级更高，传了会盖掉 preset）；
 *    例外：预加载的模型不吃 preset，此时改由命令行直传，记 `preload-override`
 * 4. 候选参数名在当前版本一个都不存在 → 记 `unsupported` 并告警，绝不硬传
 * 5. 否则按 `render` 决定"带值还是纯开关"，追加进 argv，记 `cli`
 *
 * 两条贯穿始终的原则：
 * - **参数名一律走 `caps.pick(candidates)`**，版本改名不用改这里的代码
 * - **不做静默降级**：任何兼容回退都会同时写进 `steps`（`fallback`）和 `warnings`，
 *   例如没有 `--fit-target` 时退回 `-ngl 99`，会明确告知而不是悄悄变成纯 CPU 推理
 *
 * @param input 配置、能力视图与若干上下文（preset 键集合、预加载模型等），见 {@link BuildInput}
 * @returns 最终 argv、需附加的环境变量、逐参数决策记录与告警，见 {@link BuildResult}
 */
export function buildArgs(input: BuildInput): BuildResult {
  const { config, caps } = input;
  // 内部不带 reasonLabel，统一在返回前补 —— 免得每个 push 点都手写一遍文案
  const steps: Omit<BuildStep, "reasonLabel">[] = [];
  const argv: string[] = [];
  const env: Record<string, string> = { ...(config.extra_env ?? {}) };
  const warnings: string[] = [];

  const presetKeys = new Set((input.presetKeys ?? []).map((k) => k.toLowerCase()));
  const preloadFile = input.preloadModelFile ?? null;
  const isPreload = typeof preloadFile === "string" && preloadFile !== "";
  const mode: ServerMode = config.mode === "router" ? "router" : "single";

  const presetOwns = (presetKey?: string): boolean =>
    presetKey !== undefined && presetKeys.has(presetKey.toLowerCase());

  /**
   * 处理一个配置项：按「未配置 → 主动跳过 → preset 接管 → 版本不支持 → 正常传」的顺序判定，
   * 并把结论记为一条 {@link BuildStep}。所有参数都走这一个函数，保证判定顺序一致、
   * 决策表的文案也一致。
   *
   * @param opts 该项的取值、候选参数名、preset 键与渲染方式，见 {@link EmitOptions}
   */
  function emit(opts: EmitOptions): void {
    const { key, label, candidates } = opts;
    const value = opts.value;

    if (value === undefined || value === null || value === "") {
      // 说明文字只在传参时才用，避免"未配置"后面跟着一句参数改名提示，读起来像已生效
      steps.push({ key, label, argv: [], reason: "unset", note: "未配置，用 llama.cpp 默认值" });
      return;
    }

    if (opts.skipWhen) {
      const why = opts.skipWhen(value);
      if (why !== null) {
        steps.push({ key, label, argv: [], reason: "skipped", note: why });
        return;
      }
    }

    const owned = presetOwns(opts.presetKey);
    if (owned && !(opts.preloadBypass === true && isPreload)) {
      steps.push({
        key,
        label,
        argv: [],
        reason: "preset-owned",
        note: `配置里的预设为某个模型定义了 ${opts.presetKey}，命令行不重复传（实测命令行优先级更高，会盖掉 preset）`,
      });
      return;
    }

    const flag = caps.pick(candidates);
    if (flag === null) {
      steps.push({
        key,
        label,
        argv: [],
        reason: "unsupported",
        note: `当前 llama.cpp 版本没有这些参数：${candidates.join(" / ")}`,
      });
      warnings.push(`${label}：当前版本不支持 ${candidates.join(" / ")}，已跳过`);
      return;
    }

    const rendered = opts.render ? opts.render(flag, value) : String(value);
    const part = rendered === null ? [flag] : [flag, rendered];
    const reason: StepReason = opts.reasonOverride ?? (owned ? "preload-override" : "cli");
    argv.push(...part);
    steps.push({
      key,
      label,
      argv: part,
      reason,
      note:
        opts.note ??
        (reason === "preload-override"
          ? "预加载模式下 preset 对该模型不生效，改由命令行直传"
          : "由命令行传入"),
    });
    if (opts.warning) warnings.push(opts.warning);
  }

  // =========================================================== 1. router：模型目录
  if (mode === "router") {
    emit({
      key: "models_dir",
      label: "模型目录",
      candidates: ["--models-dir"],
      value: config.models_dir,
      note: "router 模式：网页左上角可随时切换模型，无需重启",
    });
    if (!config.models_dir) {
      warnings.push(
        "router 模式但没有设置 models_dir，llama-server 启动后会没有任何可用模型"
          + "（预设 presets 只负责给模型覆盖参数，不能代替模型目录）",
      );
    }
  }

  // =========================================================== 2. 监听地址 / 端口
  emit({ key: "host", label: "监听地址", candidates: ["--host"], value: config.host ?? "127.0.0.1" });
  emit({ key: "port", label: "端口", candidates: ["--port"], value: config.port ?? 8080 });

  // =========================================================== 3. router：模型预设
  // 预设现在写在配置里（config.presets），这里只报"渲染出来的那份临时 ini"：
  // 路径由 prepareLaunch 生成，用户不需要（也不该）关心它具体在哪。
  if (mode === "router" && input.presetArgPath != null) {
    emit({
      key: "models_preset",
      label: "模型预设文件（自动生成）",
      candidates: ["--models-preset"],
      value: input.presetArgPath,
      note: "由配置里的 presets 渲染成临时 ini；preset 里定义过的键按模型接管，命令行不再重复传",
    });
  }

  // =========================================================== 4. 主模型 / 预加载
  if (mode === "router") {
    if (isPreload) {
      emit({
        key: "preload_model",
        label: "启动预加载模型",
        candidates: ["--model"],
        value: preloadFile,
        note: "启动即加载（实测 router 模式传 --model 会立即加载，无需等第一次请求）",
      });
    } else {
      steps.push({
        key: "preload_model",
        label: "启动预加载模型",
        argv: [],
        reason: "skipped",
        note: "未预加载：首次请求时才加载模型",
      });
    }
    emit({
      key: "models_max",
      label: "同时加载模型数",
      candidates: ["--models-max"],
      value: config.models_max ?? null,
      skipWhen: (v) => (typeof v === "number" && v <= 0 ? "已设为不限制" : null),
    });
  } else {
    emit({
      key: "main_model",
      label: "主模型",
      candidates: ["-m", "--model"],
      value: config.main_model,
    });
    if (!config.main_model) warnings.push("single 模式但没有指定主模型");
  }

  // =========================================================== 5. 视觉 / 草稿模型
  emit({ key: "vision_model", label: "视觉投影文件", candidates: ["-mm", "--mmproj"], value: config.vision_model });
  emit({
    key: "draft_model",
    label: "草稿模型",
    candidates: ["--spec-draft-model", "-md", "--model-draft"],
    value: config.draft_model,
    note: "b10488 起改名为 --spec-draft-model（旧名 --model-draft）",
  });

  // =========================================================== 6. 线程 / 上下文 / YaRN
  emit({
    key: "threads",
    label: "CPU 线程数",
    candidates: ["-t", "--threads"],
    presetKey: "threads",
    preloadBypass: true,
    value: config.threads,
    skipWhen: (v) => (typeof v === "number" && v <= 0 ? "已设为自动（llama.cpp 用物理核数）" : null),
  });

  const ctxFromPreset = input.preloadCtxFromPreset ?? null;
  const ctxValue = isPreload && ctxFromPreset !== null ? ctxFromPreset : config.context;
  emit({
    key: "context",
    label: "上下文长度",
    candidates: ["-c", "--ctx-size"],
    presetKey: "ctx-size",
    preloadBypass: true,
    value: ctxValue,
    note:
      isPreload && ctxFromPreset !== null
        ? `预加载模型不吃 preset，ctx 必须 CLI 直传（取自配置预设里的 ctx-size = ${ctxFromPreset}）`
        : undefined,
  });

  const yarnOn = Boolean(config.rope_scaling) && config.rope_scaling !== "none";
  if (yarnOn && !config.rope_scale) warnings.push("已开启 RoPE 缩放，但没有给 --rope-scale");
  emit({ key: "rope_scaling", label: "RoPE 缩放方式", candidates: ["--rope-scaling"], value: config.rope_scaling });
  emit({
    key: "rope_scale",
    label: "RoPE 缩放系数",
    candidates: ["--rope-scale"],
    value: config.rope_scale,
    skipWhen: () => (yarnOn ? null : "YaRN 未开启"),
  });
  emit({
    key: "yarn_orig_ctx",
    label: "YaRN 原始上下文",
    candidates: ["--yarn-orig-ctx"],
    value: config.yarn_orig_ctx,
    skipWhen: () => (yarnOn ? null : "YaRN 未开启"),
    note: "有些 GGUF 已把 YaRN 烤进 metadata，重复设置反而会出问题",
  });

  // =========================================================== 7. 生成上限 / 批处理
  emit({
    key: "max_predict",
    label: "单次生成上限",
    candidates: ["-n", "--predict", "--n-predict"],
    presetKey: "n-predict",
    value: config.max_predict,
    note: "llama-server 默认 -1（无限），模型复读时会吃满上下文；网页端 max tokens 会覆盖它，两边都要设",
  });
  emit({ key: "batch_size", label: "逻辑批大小", candidates: ["-b", "--batch-size"], value: config.batch_size });
  emit({ key: "ubatch_size", label: "物理批大小", candidates: ["-ub", "--ubatch-size"], value: config.ubatch_size });

  // =========================================================== 8. Flash Attention
  // ⚠ llama.cpp 的默认值是 auto（通常等于开启），所以「用户关掉」必须显式传 off，
  //   悄悄不传等于没关 —— 这是界面把三态参数做成开关后最容易出的错。
  const faFlag = caps.pick(["-fa", "--flash-attn"]);
  if (faFlag !== null && caps.hasValue(faFlag)) {
    emit({
      key: "flash_attention",
      label: "Flash Attention",
      candidates: ["-fa", "--flash-attn"],
      presetKey: "flash-attn",
      value: config.flash_attention === null || config.flash_attention === undefined
        ? null
        : config.flash_attention
          ? "on"
          : "off",
      note: "本版本是 -fa on/off/auto 的新语法，关闭会显式传 off",
    });
  } else {
    emit({
      key: "flash_attention",
      label: "Flash Attention",
      candidates: ["-fa", "--flash-attn"],
      presetKey: "flash-attn",
      value: config.flash_attention,
      skipWhen: (v) => (v === false ? "已关闭（本版本 -fa 是纯开关，无法显式关闭，只能不传）" : null),
      render: () => null,
      note: "本版本 -fa 是纯开关，不受值语法支持",
    });
  }

  // =========================================================== 9. KV cache
  emit({
    key: "kv_k_type",
    label: "K cache 量化",
    candidates: ["--cache-type-k"],
    presetKey: "cache-type-k",
    preloadBypass: true,
    value: config.kv_k_type,
  });
  emit({
    key: "kv_v_type",
    label: "V cache 量化",
    candidates: ["--cache-type-v"],
    presetKey: "cache-type-v",
    preloadBypass: true,
    value: config.kv_v_type,
    note: "V cache 量化必须有 Flash Attention 撑着",
  });

  // =========================================================== 10. Jinja 模板
  // ⚠ 同上：--jinja 在 llama.cpp 里默认是【启用】的，界面上关掉必须传 --no-jinja，
  //   不传等于还开着。
  if (config.jinja === false) {
    const noJinja = caps.pick(["--no-jinja"]);
    if (noJinja !== null) {
      const part = [noJinja];
      argv.push(...part);
      steps.push({
        key: "jinja",
        label: "启用 Jinja 模板",
        argv: part,
        reason: "cli",
        note: "显式关闭（llama.cpp 默认启用 Jinja，不传就等于开着）",
      });
    } else {
      steps.push({
        key: "jinja",
        label: "启用 Jinja 模板",
        argv: [],
        reason: "unsupported",
        note: "本版本没有 --no-jinja，无法显式关闭（llama.cpp 默认就是启用）",
      });
      warnings.push("Jinja 模板：当前版本没有 --no-jinja，无法关闭，将保持默认启用");
    }
  } else {
    emit({
      key: "jinja",
      label: "启用 Jinja 模板",
      candidates: ["--jinja"],
      value: config.jinja === true ? true : null,
      render: (flag) => (caps.hasValue(flag) ? "on" : null),
      note: "正确套用模型自带对话模板 + 工具调用",
    });
  }

  // =========================================================== 11. 思考模式
  const think = normalizeThink(config.think);
  let reasoningFormatEmitted = false;

  if (think === null) {
    steps.push({
      key: "think",
      label: "思考模式",
      argv: [],
      reason: "unset",
      note: "未设置，不干预模型默认行为",
    });
  } else {
    const reasoningFlag = caps.pick(["--reasoning"]);
    if (reasoningFlag !== null && caps.hasValue(reasoningFlag)) {
      const part = [reasoningFlag, think];
      argv.push(...part);
      steps.push({
        key: "think",
        label: "思考模式",
        argv: part,
        reason: "cli",
        note: think === "on" ? "开启思考" : think === "off" ? "关闭思考，直接出答案" : "不干预，跟随模型默认",
      });
    } else {
      // 旧版回退：--reasoning-budget + LLAMA_ARG_CHAT_TEMPLATE_KWARGS 双管齐下
      const parts: string[] = [];
      const budgetFlag = caps.pick(["--reasoning-budget"]);
      const hasKwargs = caps.has("--chat-template-kwargs");
      if (hasKwargs) {
        env[CHAT_TEMPLATE_KWARGS_ENV] = JSON.stringify({ enable_thinking: think === "on" });
      }
      if (budgetFlag !== null && !presetOwns("reasoning-budget")) {
        parts.push(budgetFlag, think === "off" ? "0" : "-1");
      }
      if (think === "on") {
        const fmt = caps.pick(["--reasoning-format"]);
        if (fmt !== null) {
          parts.push(fmt, "auto");
          reasoningFormatEmitted = true;
        }
      }
      if (parts.length === 0 && !hasKwargs) {
        steps.push({
          key: "think",
          label: "思考模式",
          argv: [],
          reason: "unsupported",
          note: "本版本无法从服务端控制思考，只能在提问末尾加 /no_think",
        });
        warnings.push("当前 llama.cpp 版本不支持服务端思考开关，请在提问末尾加 /no_think");
      } else {
        argv.push(...parts);
        steps.push({
          key: "think",
          label: "思考模式",
          argv: parts,
          reason: "fallback",
          note: "本版本用 --reasoning-budget + 环境变量 LLAMA_ARG_CHAT_TEMPLATE_KWARGS 实现思考开关",
        });
        if (env[CHAT_TEMPLATE_KWARGS_ENV]) {
          steps.push({
            key: "think_env",
            label: "思考模板变量",
            argv: [],
            reason: "fallback",
            note: `${CHAT_TEMPLATE_KWARGS_ENV}=${env[CHAT_TEMPLATE_KWARGS_ENV]}（PowerShell 会把 JSON 双引号剥掉，所以走环境变量）`,
          });
        }
      }
    }
  }

  emit({
    key: "reasoning_effort",
    label: "思考强度",
    candidates: ["--reasoning-effort"],
    value: config.reasoning_effort,
  });
  emit({
    key: "reasoning_budget",
    label: "思考预算",
    candidates: ["--reasoning-budget"],
    presetKey: "reasoning-budget",
    value: config.reasoning_budget,
    note: "0 = 立刻掐掉思考，-1 = 不限",
  });

  if (config.reasoning_preserve === true) {
    const fmt = caps.pick(["--reasoning-format"]);
    if (fmt === null) {
      steps.push({
        key: "reasoning_preserve",
        label: "保留思考内容",
        argv: [],
        reason: "unsupported",
        note: "当前版本没有 --reasoning-format",
      });
      warnings.push("保留思考内容：当前版本不支持 --reasoning-format，已跳过");
    } else if (reasoningFormatEmitted) {
      steps.push({
        key: "reasoning_preserve",
        label: "保留思考内容",
        argv: [],
        reason: "skipped",
        note: "思考模式已经传过 --reasoning-format auto，不重复传",
      });
    } else {
      const part = [fmt, "auto"];
      argv.push(...part);
      steps.push({
        key: "reasoning_preserve",
        label: "保留思考内容",
        argv: part,
        reason: "cli",
        note: "思考内容走独立字段，前端可折叠显示",
      });
    }
  }

  // =========================================================== 12. 采样
  emit({ key: "temperature", label: "温度", candidates: ["--temp"], presetKey: "temperature", value: config.temperature });
  emit({ key: "top_p", label: "top-p", candidates: ["--top-p"], presetKey: "top-p", value: config.top_p });
  emit({ key: "top_k", label: "top-k", candidates: ["--top-k"], presetKey: "top-k", value: config.top_k });
  emit({ key: "min_p", label: "min-p", candidates: ["--min-p"], presetKey: "min-p", value: config.min_p });
  emit({
    key: "presence_penalty",
    label: "存在惩罚",
    candidates: ["--presence-penalty"],
    presetKey: "presence-penalty",
    value: config.presence_penalty,
  });
  emit({
    key: "repeat_penalty",
    label: "重复惩罚",
    candidates: ["--repeat-penalty"],
    presetKey: "repeat-penalty",
    value: config.repeat_penalty,
  });

  // =========================================================== 13. 显存分配
  const nglCandidates = ["-ngl", "--gpu-layers", "--n-gpu-layers"];
  const gpuLayersRaw = config.gpu_layers;
  const gpuLayersNum =
    typeof gpuLayersRaw === "number"
      ? gpuLayersRaw
      : typeof gpuLayersRaw === "string" && /^\d+$/.test(gpuLayersRaw.trim())
        ? Number(gpuLayersRaw.trim())
        : null;

  if (gpuLayersNum !== null) {
    emit({
      key: "gpu_layers",
      label: "显存分层数",
      candidates: nglCandidates,
      presetKey: "n-gpu-layers",
      preloadBypass: true,
      value: gpuLayersNum,
      note: "手动指定分层数",
    });
  } else if (caps.has("--fit-target")) {
    emit({
      key: "fit_target",
      label: "显存余量目标",
      candidates: ["--fit-target", "-fitt"],
      presetKey: "fit-target",
      preloadBypass: true,
      value: config.fit_target,
      note: "交给 --fit 实测显存后自动分层，比人肉试 -ngl 准；值越小模型上卡越多",
    });
  } else if (input.cpuOnly !== true) {
    emit({
      key: "gpu_layers",
      label: "显存分层数",
      candidates: nglCandidates,
      presetKey: "n-gpu-layers",
      preloadBypass: true,
      value: 99,
      reasonOverride: "fallback",
      note: "本版本没有 --fit-target，退回 -ngl 99（全量 offload），避免静默变成纯 CPU 推理",
      warning: "当前 llama.cpp 版本不支持 --fit-target，已回退 -ngl 99（全量 offload）",
    });
  } else {
    steps.push({
      key: "gpu_layers",
      label: "显存分层数",
      argv: [],
      reason: "skipped",
      note: "纯 CPU 模式，不做 GPU offload",
    });
  }
  emit({ key: "fit", label: "自动适配显存", candidates: ["-fit", "--fit"], value: config.fit });
  emit({ key: "fit_ctx", label: "fit 最小 ctx", candidates: ["-fitc", "--fit-ctx"], value: config.fit_ctx });

  // =========================================================== 14. 模型加载模式
  if (config.load_mode) {
    if (caps.has("--load-mode")) {
      emit({
        key: "load_mode",
        label: "模型加载模式",
        candidates: ["--load-mode", "-lm"],
        presetKey: "load-mode",
        preloadBypass: true,
        value: config.load_mode,
        note: "避免 Windows 把模型页换到磁盘导致速度暴跌",
      });
    } else if (caps.has("--mlock")) {
      emit({
        key: "load_mode",
        label: "模型加载模式",
        candidates: ["--mlock"],
        presetKey: "load-mode",
        preloadBypass: true,
        value: true,
        render: () => null,
        reasonOverride: "fallback",
        note: `本版本没有 --load-mode，退回旧参数 --mlock（原设定 ${config.load_mode}）`,
        warning: `当前版本不支持 --load-mode，已用 --mlock 替代（原设定 ${config.load_mode}）`,
      });
    } else {
      steps.push({
        key: "load_mode",
        label: "模型加载模式",
        argv: [],
        reason: "unsupported",
        note: "当前版本既没有 --load-mode 也没有 --mlock",
      });
      warnings.push("模型加载模式：当前版本不支持 --load-mode / --mlock，已跳过");
    }
  } else {
    emit({
      key: "mlock",
      label: "锁内存（旧参数）",
      candidates: ["--mlock"],
      value: config.mlock,
      skipWhen: (v) => (v === true ? null : "已关闭"),
      render: () => null,
    });
  }
  emit({
    key: "no_mmap",
    label: "禁用内存映射",
    candidates: ["--no-mmap"],
    value: config.no_mmap,
    skipWhen: (v) => (v === true ? null : "已关闭"),
    render: () => null,
  });

  // =========================================================== 15. 其它服务参数
  emit({
    key: "parallel",
    label: "并发槽位",
    candidates: ["-np", "--parallel"],
    value: config.parallel,
    skipWhen: (v) => (typeof v === "number" && v <= 0 ? "已设为自动" : null),
  });
  emit({ key: "api_key", label: "API Key", candidates: ["--api-key"], value: config.api_key });
  emit({ key: "alias", label: "模型别名", candidates: ["--alias"], value: config.alias });
  emit({ key: "log_file", label: "日志文件", candidates: ["--log-file"], value: config.log_file });
  emit({
    key: "split_mode",
    label: "多卡切分方式",
    candidates: ["--split-mode"],
    value: config.split_mode,
  });
  emit({ key: "main_gpu", label: "主显卡编号", candidates: ["--main-gpu"], value: config.main_gpu });
  emit({
    key: "cpu_moe",
    label: "MoE 权重全放 CPU",
    candidates: ["-cmoe", "--cpu-moe"],
    value: config.cpu_moe,
    skipWhen: (v) => (v === true ? null : "已关闭"),
    render: () => null,
  });
  emit({
    key: "cpu_moe_layers",
    label: "前 N 层 MoE 放 CPU",
    candidates: ["-ncmoe", "--n-cpu-moe"],
    value: config.cpu_moe_layers,
  });
  emit({
    key: "no_warmup",
    label: "跳过预热",
    candidates: ["--no-warmup"],
    value: config.no_warmup,
    skipWhen: (v) => (v === true ? null : "已关闭"),
    render: () => null,
  });
  emit({
    key: "no_webui",
    label: "禁用内置 WebUI",
    candidates: ["--no-webui"],
    value: config.no_webui,
    skipWhen: (v) => (v === true ? null : "已关闭"),
    render: () => null,
  });
  emit({
    key: "metrics",
    label: "暴露 Prometheus 指标",
    candidates: ["--metrics"],
    value: config.metrics,
    skipWhen: (v) => (v === true ? null : "已关闭"),
    render: () => null,
  });

  // =========================================================== 16. 工具
  emit({
    key: "tools_all",
    label: "启用全部内置工具",
    candidates: ["--tools"],
    value: config.tools_all,
    skipWhen: (v) => (v === true ? null : "已关闭"),
    render: () => "all",
    note: "experimental：会放开文件读写 / grep 等工具，不要在不可信环境开启",
  });
  emit({
    key: "agent",
    label: "Agent 模式",
    candidates: ["--agent", "-ag"],
    value: config.agent,
    skipWhen: (v) => (v === true ? null : "已关闭"),
    render: (flag) => (caps.hasValue(flag) ? "on" : null),
    note: "启用 CORS 代理 + 全部内置工具",
  });

  // =========================================================== 17. 推测解码
  emit({ key: "spec_type", label: "推测解码类型", candidates: ["--spec-type"], value: config.spec_type });
  emit({
    key: "draft_n",
    label: "草稿 token 数",
    candidates: ["--spec-draft-n-max", "--draft-n", "--draft-max"],
    value: config.draft_n,
  });
  emit({
    key: "draft_type_k",
    label: "草稿 K cache 量化",
    candidates: ["--spec-draft-type-k", "-ctkd", "--cache-type-k-draft", "--draft-type-k"],
    value: config.draft_type_k,
    note: "b10488 起改名为 --spec-draft-type-k",
  });
  emit({
    key: "draft_type_v",
    label: "草稿 V cache 量化",
    candidates: ["--spec-draft-type-v", "-ctvd", "--cache-type-v-draft", "--draft-type-v"],
    value: config.draft_type_v,
    note: "b10488 起改名为 --spec-draft-type-v",
  });

  // =========================================================== 18. 自定义参数（原样追加，最后放，方便覆盖前面）
  const custom = splitCustomArgs(config.custom_args ?? "");
  if (custom.length > 0) {
    argv.push(...custom);
    steps.push({
      key: "custom_args",
      label: "自定义参数",
      argv: custom,
      reason: "cli",
      note: "用户自定义，原样追加在最后",
    });
  } else {
    steps.push({ key: "custom_args", label: "自定义参数", argv: [], reason: "unset", note: "无自定义参数" });
  }

  return {
    argv,
    env,
    // 统一补上原因文案：CLI 与 GUI 用同一份，避免两边措辞漂移
    steps: steps.map((s) => ({ ...s, reasonLabel: REASON_LABEL[s.reason] })),
    warnings,
  };
}
