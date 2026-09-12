/**
 * 日志行处理：行缓冲 + 关键事件识别 + 启动失败诊断。
 *
 * `child_process` 的 stdout 是按块（chunk）给的，块边界会把一行切成两半 ——
 * 不自己做行缓冲，日志面板里会随机出现半行。这是 Windows 下最容易被忽略的坑之一。
 */

/**
 * 行缓冲器：把 `child_process` 按块吐出的输出重新拼成完整行。
 *
 * 为什么必须有它：stdout 的 chunk 边界与行边界无关，一行经常被切成两块
 * （"模型加载" 与 "完成" 分属两个 chunk）。不做缓冲，界面日志里就会随机出现半行，
 * 而且按行做的关键字判断（监听/报错）也会漏。
 *
 * 使用约定：运行期反复调 {@link LineSplitter.push}；进程退出后用 {@link LineSplitter.flush}
 * 取回最后一段没换行的残留。实例不共享，一个进程一个。
 */
export class LineSplitter {
  private buf = "";

  /**
   * 喂入一块输出，返回其中**已经完整**的行。
   *
   * 边界处理：
   * - 兼容 `\r\n`（Windows）与 `\n`，返回的行末尾不带 `\r`
   * - 结尾没换行的部分留在内部缓冲里，等下一块；本次不会返回
   * - 兜底：若缓冲超过 1_000_000 字符仍无换行（进程异常输出），
   *   直接把它当作一行吐出并清空缓冲，避免内存被吃光
   *
   * @param chunk 新到达的输出片段（调用方负责按 utf8 解码）
   * @returns 本次能确定的完整行；没有则为空数组
   */
  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let idx = this.buf.indexOf("\n");
    while (idx !== -1) {
      let line = this.buf.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
      this.buf = this.buf.slice(idx + 1);
      idx = this.buf.indexOf("\n");
    }
    // 兜底：万一进程输出一直不带换行，别把内存吃光
    if (this.buf.length > 1_000_000) {
      lines.push(this.buf);
      this.buf = "";
    }
    return lines;
  }

  /**
   * 取回缓冲区里最后一段没有换行结尾的残留。
   *
   * 应在进程退出后调用一次（否则最后一行日志会丢），调用后缓冲被清空；
   * 重复调用会得到空数组。
   *
   * @returns 残留内容组成的数组（0 或 1 个元素）
   */
  flush(): string[] {
    if (this.buf === "") return [];
    const rest = this.buf;
    this.buf = "";
    return [rest];
  }

  /** 当前尚未闭合的残留文本，只读；用于调试或界面展示进度 */
  get pending(): string {
    return this.buf;
  }
}

/**
 * 日志行的大类，决定界面用什么颜色、是否要额外提示。
 *
 * - `server-starting`：进程刚起来的通用信息
 * - `listening`：端口已开始监听（判断"服务可用了"的可靠信号）
 * - `model-loading`：模型加载过程的细节（tensor、上下文、后端等）
 * - `model-loaded`：模型加载完成
 * - `model-list`：router 模式列出的可用模型清单
 * - `perf`：吞吐统计（tok/s）
 * - `warning`：告警
 * - `oom`：显存/内存不足 —— 最需要醒目提示的一类
 * - `error`：错误
 * - `other`：未归类
 */
export type LogEventKind =
  | "server-starting"
  | "listening"
  | "model-loading"
  | "model-loaded"
  | "model-list"
  | "perf"
  | "warning"
  | "oom"
  | "error"
  | "other";

/** 从日志行里顺带抽出来的数值，全部可选：抽不到就是 `undefined`，不代表 0 */
export interface LogMetrics {
  /** prompt 处理速度（tok/s），来自 `prompt eval time = ...` 那一行 */
  promptEvalTokPerSec?: number;
  /** 生成速度（tok/s），来自 `eval time = ...` 那一行 */
  evalTokPerSec?: number;
  /** 实际生效的上下文长度，来自 `n_ctx = N` */
  nCtx?: number;
  /** 卸载到 GPU 的层数，形如 `33/33` */
  offloadedLayers?: string;
}

/** {@link classify} 的返回值：一行日志的分类、等级、抽出的数值与原文本 */
export interface LogEvent {
  kind: LogEventKind;
  level: "info" | "warn" | "error";
  /** 去掉首尾空白的正文，用于展示 */
  message: string;
  metrics: LogMetrics;
  /** 原始行（未裁剪），便于导出或重新解析 */
  raw: string;
}

const RE_LISTENING = /server is listening|starting the main loop|listening on/i;
const RE_MODEL_LOADING = /llama_model_loader:|load_tensors:|llama_context:|loading model|print_info:/i;
const RE_MODEL_LOADED = /model loaded|main: model loaded|loaded the model|all slots are idle/i;
const RE_MODEL_LIST = /available models|loaded \d+ custom model presets|model preset/i;
const RE_OOM = /out of memory|cuda_error_out_of_memory|failed to allocate|host_malloc|ggml_backend_cuda_buffer_type_alloc_buffer/i;
const RE_ERROR = /\berror\b|failed to|invalid|unknown model|not recognized|exception|abort/i;
const RE_WARN = /\bwarn(ing)?\b/i;
const RE_PERF_PROMPT = /prompt eval time\s*=\s*[\d.]+ ms\s*\/\s*\d+ tokens.*?([\d.]+) tokens per second/i;
const RE_PERF_EVAL = /^\s*eval time\s*=\s*[\d.]+ ms\s*\/\s*\d+ tokens.*?([\d.]+) tokens per second/i;
const RE_NCTX = /n_ctx\s*=\s*(\d+)/;
const RE_OFFLOAD = /offloaded\s+(\d+\/\d+)\s+layers to GPU/i;
/**
 * b10488 的日志已经是结构化的：`0.00.146.987 W srv  llama_server: <message>`，
 * 也就是 `<累计时间> <等级 I|W|E|D> <组件> <函数>: <正文>`。
 * 实测样例：
 *   0.00.146.987 W srv  llama_server: CORS is set to allow all origins ('*') ...
 *   0.00.149.953 I srv  llama_server: listening on http://127.0.0.1:8099
 * 有这个前缀时等级以它为准，比关键词猜测可靠（"security risk" 这类不含 warn 字样的告警就靠它）。
 */
const RE_LEVEL_PREFIX = /^\d+(?:\.\d+)*\s+([IWED])\s/;

/**
 * 把一行 llama-server 日志分类，并顺带抽出可展示的数值。
 *
 * 判定顺序即优先级（先命中先返回，后面的不再看）：
 * 1. `oom` —— 显存不足最需要醒目，且这类行往往同时含 `error` 字样
 * 2. `listening` / `model-loaded` / `model-list` —— 状态类，抓的是明确短语
 * 3. `perf` —— 只要抽到了 tok/s 就算性能行
 * 4. `error` / `warning` —— **必须排在 `model-loading` 之前**，
 *    否则 `llama_model_loader: warning: ...` 会被吞进"模型加载中"这一桶里
 * 5. `model-loading` —— 兜底的加载过程信息
 * 6. 最后再退回结构化前缀里的等级字母（`E` → error，`W` → warning）
 *
 * 等级来源有两处：优先用 b10488 结构化前缀里的字母（`0.00.146.987 W srv ...`），
 * 它比关键词可靠（`CORS is set to allow all origins` 这类告警不含 warn 字样）；
 * 没有前缀的老版本日志再退回关键词判断。
 *
 * 本函数**永不抛异常**，未识别的行归类为 `other` / `info`。
 *
 * @param line 一行完整日志（应由 {@link LineSplitter} 拼好，不要传半行）
 * @returns 分类结果，见 {@link LogEvent}
 */
export function classify(line: string): LogEvent {
  const metrics: LogMetrics = {};
  const promptMatch = RE_PERF_PROMPT.exec(line);
  if (promptMatch && promptMatch[1]) metrics.promptEvalTokPerSec = Number(promptMatch[1]);
  const evalMatch = RE_PERF_EVAL.exec(line);
  if (evalMatch && evalMatch[1]) metrics.evalTokPerSec = Number(evalMatch[1]);
  const ctxMatch = RE_NCTX.exec(line);
  if (ctxMatch && ctxMatch[1]) metrics.nCtx = Number(ctxMatch[1]);
  const offloadMatch = RE_OFFLOAD.exec(line);
  if (offloadMatch && offloadMatch[1]) metrics.offloadedLayers = offloadMatch[1];

  const structuredMatch = RE_LEVEL_PREFIX.exec(line);
  const structured = structuredMatch?.[1] ?? null;

  let level: LogEvent["level"] = structured === "E" ? "error" : structured === "W" ? "warn" : "info";
  let kind: LogEventKind = "other";

  if (RE_OOM.test(line)) {
    kind = "oom";
    level = "error";
  } else if (RE_LISTENING.test(line)) {
    kind = "listening";
  } else if (RE_MODEL_LOADED.test(line)) {
    kind = "model-loaded";
  } else if (RE_MODEL_LIST.test(line)) {
    kind = "model-list";
  } else if (metrics.evalTokPerSec !== undefined || metrics.promptEvalTokPerSec !== undefined) {
    kind = "perf";
  } else if (RE_ERROR.test(line)) {
    // 注意：错误/告警判定要放在 model-loading 之前，
    // 否则 `llama_model_loader: warning: ...` 会被吞进"模型加载中"这一桶里
    kind = "error";
    level = "error";
  } else if (RE_WARN.test(line)) {
    kind = "warning";
    level = "warn";
  } else if (RE_MODEL_LOADING.test(line)) {
    kind = "model-loading";
  } else if (structured === "E") {
    kind = "error";
  } else if (structured === "W") {
    kind = "warning";
  }

  return { kind, level, message: line.trim(), metrics, raw: line };
}

/**
 * 启动失败的诊断结论：一句人话总结 + 若干可执行的下一步动作。
 *
 * `code` 是稳定的机器可读标识（如 `vram-oom`），供界面做去重或按类展示；
 * 面向用户的文案都在 `summary` / `suggestions` 里。
 */
export interface Diagnosis {
  code: string;
  summary: string;
  suggestions: string[];
}

/** 一条诊断规则：命中 `re` 就采用该条结论 */
interface DiagnosisRule {
  code: string;
  re: RegExp;
  summary: string;
  suggestions: string[];
}

/**
 * 启动失败诊断：把日志关键行翻译成人话 + 给出下一步动作。
 * 顺序即优先级 —— 显存不足和端口占用都能刷出 "error" 字样，必须先匹配它们。
 */
const DIAGNOSIS_RULES: readonly DiagnosisRule[] = [
  {
    code: "vram-oom",
    re: /out of memory|cuda_error_out_of_memory|failed to allocate|host_malloc/i,
    summary: "显存不足：模型/上下文的显存需求超过了当前可用显存",
    suggestions: [
      "调小上下文：-c 从 16384 起试（ctx 翻倍，KV cache 也翻倍）",
      "压缩 KV cache：--cache-type-k q4_0 --cache-type-v q4_0（V 侧需要 Flash Attention 生效）",
      "调小 --fit-target（默认 1024 MiB），让 --fit 把更多层放上卡；激进可试 512",
      "MoE 模型可把专家权重甩到内存：--n-cpu-moe N 或 --cpu-moe",
      "减少 --models-max，避免多个模型同时占显存",
    ],
  },
  {
    code: "port-in-use",
    re: /couldn't bind|address already in use|failed to bind|bind\(\) failed|EADDRINUSE/i,
    summary: "端口被占用：监听端口已被其它进程占用",
    suggestions: ["换一个端口（启动器会自动顺延）", '查占用：netstat -ano | findstr ":端口号"'],
  },
  {
    code: "preset-parse",
    re: /failed to parse server config file|error parsing|ini/i,
    summary: "presets.ini 解析失败",
    suggestions: [
      "文件必须是 UTF-8 且【不带 BOM】，带 BOM 会直接解析失败",
      "行尾不要有 Windows 以外的怪字符，键值用 `key = value`",
      "路径含中文会让 llama-server 崩退，先把 presets.ini 拷到纯 ASCII 路径再传",
    ],
  },
  {
    code: "option-unsupported",
    re: /option not recognized|invalid argument|unknown argument|unrecognized option/i,
    summary: "传了当前 llama.cpp 版本不认识的参数",
    suggestions: [
      "参数名随版本改动（例：--draft-type-k → --spec-draft-type-k），启动器会在运行时探测 --help",
      "检查「自定义参数」栏里是否写了本版本没有的选项",
    ],
  },
  {
    code: "no-models",
    re: /no models found|loaded 0 custom model presets|no model specified|no model provided/i,
    summary: "没有找到可用模型（或 preset 段名与模型名不匹配）",
    suggestions: [
      "--models-dir 指向的目录里要有 .gguf 文件",
      "presets.ini 的段名必须等于模型名（GGUF 文件名去掉 .gguf），[*] 通配段不被支持",
      "启动后看日志里模型名旁有没有 *，有 * 才表示吃到了自定义 preset",
    ],
  },
  {
    code: "model-load-failed",
    re: /failed to load model|invalid magic|unknown model architecture|error loading model|unsupported gguf/i,
    summary: "模型文件加载失败：文件损坏、下到一半，或架构不被当前版本支持",
    suggestions: ["校验文件大小是否完整（分片要全部下齐，或用 llama-gguf-split --merge 合并）", "换一个 GGUF 或升级 llama.cpp"],
  },
  {
    code: "draft-model",
    re: /draft model|speculative/i,
    summary: "推测解码相关失败（草稿模型缺失或类型不匹配）",
    suggestions: [
      "dflash / dspark / MTP 都需要单独下载草稿模型",
      "dflash 等新技术需要 b10679 及以上的开发版构建；稳定版不支持",
      "CUDA 13.x 构建要求 R580 以上驱动，驱动过旧会起不来",
    ],
  },
];

/**
 * 在最近的日志行里找最可能的失败原因。
 *
 * 按 {@link DIAGNOSIS_RULES} 的**声明顺序**匹配，先命中先返回 —— 顺序即优先级，
 * 所以"显存不足"排在"端口占用"之前：两者都会刷出 `error` 字样，
 * 但给出错误建议比不给建议更糟。
 *
 * 边界：只做"有没有"，不做因果分析，因此若日志里同时出现多种错误，
 * 返回的只是优先级最高的那一条；识别不出时返回 `null`（而不是编一个原因）。
 *
 * @param lines 待诊断的日志行，通常取进程退出前最近的若干行
 * @returns 命中的诊断结论（`suggestions` 为副本，调用方改写不会污染规则表）；识别不出返回 `null`
 */
export function diagnose(lines: readonly string[]): Diagnosis | null {
  for (const rule of DIAGNOSIS_RULES) {
    if (lines.some((l) => rule.re.test(l))) {
      return { code: rule.code, summary: rule.summary, suggestions: [...rule.suggestions] };
    }
  }
  return null;
}
