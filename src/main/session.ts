/**
 * 会话状态机 —— 「当前配置 + 探测结果 + 命令行预览 + 运行中的进程」都收敛在这里。
 *
 * 刻意**不 import electron**：主进程只负责窗口与对话框，业务逻辑全在这个类里，
 * 于是它可以被 CLI、被单测直接驱动，而不是只能通过点界面来验证。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatArgv } from "../core/args.ts";
import {
  DEFAULT_CONFIG,
  discoverLlamaDir,
  discoverModelLayout,
  loadConfigFile,
  normalizeConfig,
  resolveServerExe,
  saveConfigFile,
} from "../core/config.ts";
import { fetchHealth, findFreePort, probeTcp } from "../core/health.ts";
import { createCapabilities } from "../core/helpProbe.ts";
import { prepareLaunch, probeServer } from "../core/launcher.ts";
import { LlamaServer } from "../core/llamaProcess.ts";
import type { ServerState } from "../core/llamaProcess.ts";
import { MetricsSampler } from "../core/metrics.ts";
import { precheckWarnings, runPrecheck } from "../core/precheck.ts";
import type { PrecheckReport } from "../core/precheck.ts";
import {
  deleteProfile as deleteProfileFile,
  listProfiles as listProfileFiles,
  profilePath,
  readProfile as readProfileFile,
  saveProfile as saveProfileFile,
} from "../core/profiles.ts";
import type { ProfileInfo } from "../core/profiles.ts";
import type { Capabilities, LauncherConfig } from "../core/types.ts";
import type {
  BootstrapPayload,
  DetectPayload,
  ErrorPayload,
  HealthPayload,
  LogPush,
  MetricsPayload,
  PreviewPayload,
  ProfileLoadResult,
  ProfilesPayload,
  StartPayload,
  StatePush,
  StatusPayload,
} from "../shared/ipc.ts";
import {
  baseUrlFor,
  buildDetectPayload,
  buildPreviewPayload,
  buildSchemaPayload,
  buildStartReport,
  toLogPush,
} from "./payload.ts";

/** 内存里保留的日志条数上限：够失败诊断与界面回看，又不至于长时间运行吃掉内存 */
const LOG_BUFFER_LIMIT = 4000;

/** 会话对外推送的回调；由主进程注入，把事件转发给渲染层 */
export interface SessionEvents {
  /** 每收到一行 llama-server 日志回调一次 */
  onLog?: (entry: LogPush) => void;
  /** 进程状态变化回调（注意：这里不带 health，健康状态由界面轮询 `status()` 获取） */
  onState?: (push: StatePush) => void;
  /** 每次指标采样后的完整载荷（含历史序列，界面直接替换状态即可） */
  onMetrics?: (payload: MetricsPayload) => void;
}

/** {@link LauncherSession} 的构造选项 */
export interface SessionOptions {
  /**
   * 自动探测 llama.cpp 时额外要看的起点目录。
   *
   * 主进程会传 **exe 所在目录**：便携版双击启动时 cwd 不可靠（可能是 exe 目录、也可能是系统目录），
   * 以 exe 为锚才能找到常见的「项目目录下并列着 llama.cpp」布局。
   */
  searchDirs?: readonly string[];
}

/**
 * 一次会话的全部状态：当前配置、能力探测结果、命令行预览、运行中的进程。
 *
 * 为什么把探测结果缓存在实例上（`capsRaw` + `capsKey`）：能力探测要 spawn 一次
 * `llama-server --help`，成本不低；而只要 `llama_dir` 没变，结果就一直有效。
 * `capsKey` 记录"这份 help 是在哪个目录下探测的"，一旦目录变了就作废重探 ——
 * 否则会拿 A 版本的参数名去启动 B 版本的 llama-server。
 */
export class LauncherSession {
  private configPath: string;
  private config: LauncherConfig = { ...DEFAULT_CONFIG };
  private configWarnings: string[] = [];
  /** 原始 --help 文本（能力探测的唯一真源）；null = 还没探测过 */
  private capsRaw: string | null = null;
  /** 探测时用的 llama.cpp 目录，换了目录就要重新探测，否则参数名会张冠李戴 */
  private capsKey = "";
  private exe = "";
  private logSeq = 0;
  private logBuffer: LogPush[] = [];
  private lastPreview: PreviewPayload | null = null;
  private server = new LlamaServer();
  /** 指标采样器：懒创建（没人看监控页时不该起定时器），但对象本身很轻 */
  private sampler: MetricsSampler | null = null;
  /** 上一次自检结果与它对应的缓存键（配置没变就不必反复起 nvidia-smi） */
  private lastPrecheck: PrecheckReport | null = null;
  private precheckKey = "";
  private events: SessionEvents;
  /**
   * 自动探测 llama.cpp 时额外要看的起点目录。
   *
   * 主进程会把 **exe 所在目录**传进来：打包后的便携版里，cwd 往往是别处
   * （双击图标启动时 cwd 就落在 exe 目录甚至系统目录），只有以 exe 为锚才找得到
   * 常见的 `项目/llama.cpp` 布局。
   */
  private readonly searchDirs: readonly string[];
  /** 面向用户的通知（不是问题，例如"首次运行已生成配置"），与 warnings 分开展示 */
  private configNotices: string[] = [];

  /**
   * @param configPath 配置文件路径；文件不存在也不会报错，会生成一份默认配置并给出通知
   * @param events 日志与状态的回调，见 {@link SessionEvents}
   * @param options.searchDirs 额外的探测起点目录（打包时传 exe 目录）
   */
  constructor(configPath: string, events: SessionEvents = {}, options: SessionOptions = {}) {
    this.configPath = configPath;
    this.events = events;
    this.searchDirs = options.searchDirs ?? [];
  }

  // ------------------------------------------------------------------ 配置

  /**
   * 启动时拉一次初始状态：读配置（必要时生成）+ 打包成界面需要的载荷。
   *
   * @returns 配置路径、归一化配置、参数表、通知与告警，见 {@link BootstrapPayload}
   */
  bootstrap(): BootstrapPayload {
    this.reloadConfig();
    return this.bootstrapPayload();
  }

  /** 自动探测 llama.cpp 时的起点目录，按优先级排列（exe 目录 → cwd → 配置里写的目录） */
  private searchStartDirs(config?: LauncherConfig): string[] {
    const dirs = [...this.searchDirs, process.cwd()];
    if (config !== undefined && config.llama_dir !== "") dirs.push(config.llama_dir);
    return dirs.filter((dir) => dir !== "");
  }

  /**
   * 从磁盘重读配置；**文件不存在就生成一份默认配置**。
   *
   * 首次运行的流程刻意做成"生成 → 重新读一遍"：
   * 1. 用默认值 + 自动探测到的布局（llama.cpp 目录、`models` 目录、`presets.ini`、预加载模型）
   *    拼出初始配置，写到磁盘
   * 2. **把它当普通配置文件重新读一遍**（`loadConfigFile`），用读回来的结果作为当前配置
   *
   * 第 2 步不是多余的：这样"首次运行的内存状态"与"第二次启动读文件的状态"完全一致，
   * 不会出现"这次能用、下次启动表现不同"的怪现象（归一化的效果也一次到位）。
   *
   * 探测规则与 CLI 的 `init` 共用 {@link discoverModelLayout}。早先这里只探 llama.cpp 目录，
   * 于是打包版第一次运行拿到的配置是 `mode: single` + 空的 `models_dir`，
   * 用户一切到 router 就被告警"没有任何可用模型"（踩过）。
   *
   * 目标位置不可写（只读目录）时不影响使用，只是退化成"用内存里的默认值"并给出告警。
   */
  private reloadConfig(): void {
    if (!existsSync(this.configPath)) {
      const layout = discoverModelLayout({ startDirs: this.searchStartDirs() });
      const initial: LauncherConfig = {
        ...DEFAULT_CONFIG,
        llama_dir: layout.llamaDir ?? "",
        mode: layout.mode,
        models_dir: layout.modelsDirExists ? layout.modelsDirCandidate : "",
        models_preset: layout.presetPath,
        preload_model: layout.preloadModel,
      };

      try {
        saveConfigFile(this.configPath, initial);
      } catch (err) {
        // 写不进去：继续用内存里的默认值，但要明确告诉用户"改完记得另存为"
        this.config = initial;
        this.configNotices = [];
        this.configWarnings = [
          `配置文件不存在（${this.configPath}），且无法写入：${err instanceof Error ? err.message : String(err)}`,
          "当前使用内存里的默认值 —— 修改参数后请用「另存为」选一个可写的位置",
        ];
        if (layout.llamaDir === null) {
          this.configWarnings.push("没能自动探测到 llama.cpp 目录，请在界面里指定（或设置环境变量 LLAMA_DIR）");
        }
        return;
      }

      const reloaded = loadConfigFile(this.configPath);
      this.config = reloaded.config;
      this.configNotices = [`首次运行：已在 ${this.configPath} 生成默认配置（可以直接编辑这个文件）`];
      this.configWarnings = [...reloaded.warnings];
      if (layout.llamaDir !== null) {
        this.configNotices.push(`已自动探测到 llama.cpp 目录：${layout.llamaDir}`);
      } else {
        this.configWarnings.push(
          "没能自动探测到 llama.cpp 目录，请在左侧「构建目录」里指定（或设置环境变量 LLAMA_DIR / LLAMA_SERVER）",
        );
      }
      // 探到什么都如实说出来：模型目录与 presets.ini 直接决定了 router 模式能不能用
      if (layout.modelsDirExists) this.configNotices.push(`已自动探测到模型目录：${layout.modelsDirCandidate}`);
      if (layout.presetPath !== "") {
        this.configNotices.push(`已自动探测到 presets.ini：${layout.presetPath}（运行模式已设为 router）`);
      }
      if (layout.preloadModel !== "") {
        this.configNotices.push(`按 presets.ini 的 default-model 约定设置了预加载：${layout.preloadModel}`);
      }
      return;
    }

    const loaded = loadConfigFile(this.configPath);
    this.config = loaded.config;
    this.configWarnings = loaded.warnings;
    this.configNotices = [];
  }

  /**
   * 给界面用的"可以一键填入的路径"。
   *
   * 界面上的输入框为空时，用户看到的灰色文字只是提示示例、**不是值** ——
   * 早先有人因此以为已经设过 `models_dir`，切到 router 就被"没有任何可用模型"告警（踩过）。
   * 这里把真正探测到的候选给界面，它就能显示一个「填入 …」按钮。
   *
   * 只报告**确实存在**的东西：不存在的目录给了按钮，用户点完还是错的。
   *
   * @returns `modelsDir` / `presetPath`，没探到的为空串
   */
  private pathSuggestions(): { modelsDir: string; presetPath: string } {
    const layout = discoverModelLayout({
      startDirs: this.searchStartDirs(),
      explicitLlamaDir: this.config.llama_dir !== "" ? this.config.llama_dir : null,
    });
    return {
      modelsDir: layout.modelsDirExists ? layout.modelsDirCandidate : "",
      presetPath: layout.presetPath,
    };
  }

  /** 把当前会话状态打包成界面初始化所需的载荷（含参数表与支持情况） */
  private bootstrapPayload(): BootstrapPayload {
    return {
      configPath: this.configPath,
      config: this.config,
      warnings: this.configWarnings,
      notices: this.configNotices,
      suggestions: this.pathSuggestions(),
      schema: buildSchemaPayload(this.capabilities()),
      platform: process.platform,
      inDesktopShell: true,
    };
  }

  /**
   * 切换到另一个配置文件。
   *
   * 换配置意味着 llama.cpp 目录可能也变了，所以先把能力探测结果作废，
   * 避免用旧版本的参数名去拼新配置的命令行。
   *
   * @param path 新配置文件路径
   * @returns 新的初始化载荷
   * @throws {Error} 文件存在但无法读取或 JSON 非法时，由 `loadConfigFile` 抛出
   */
  openConfig(path: string): BootstrapPayload {
    this.configPath = path;
    this.invalidateCapabilities();
    this.reloadConfig();
    return this.bootstrapPayload();
  }

  /**
   * 保存配置（先归一化再写盘），并把本会话切换为"已保存的这一份"。
   *
   * 归一化后的结果会成为后续拼命令行的依据 —— 这样"界面上存了什么"和
   * "实际按什么启动"永远是同一份数据。
   *
   * @param config 待保存的配置（可以来自界面，未归一化）
   * @param path 目标路径；不传则覆盖当前配置文件
   * @returns 实际写入的路径与归一化告警
   * @throws {Error} 目标目录不存在或不可写时抛出（由 `saveConfigFile` 抛出）
   */
  saveConfig(config: LauncherConfig, path?: string): { ok: boolean; path: string; warnings: string[] } {
    const target = path ?? this.configPath;
    const { config: normalized, warnings } = normalizeConfig(config);
    saveConfigFile(target, normalized);
    this.configPath = target;
    this.config = normalized;
    this.configWarnings = warnings;
    // 保存之后"首次运行已生成配置"这类通知就过期了
    this.configNotices = [];
    // llama.cpp 目录可能变了，能力探测结果要作废
    if (this.capsKey !== this.capsKeyFor(normalized)) this.invalidateCapabilities();
    return { ok: true, path: target, warnings };
  }

  /** 当前配置文件路径（界面顶栏展示、另存为的默认路径都用它） */
  getConfigPath(): string {
    return this.configPath;
  }

  /** 作废能力探测缓存：清掉 help 文本与"探测时的目录"，下次用时会重新探测 */
  private invalidateCapabilities(): void {
    this.capsRaw = null;
    this.capsKey = "";
  }

  /**
   * 取当前可用的能力视图。
   *
   * @returns 已探测过则返回能力视图；**尚未探测时返回 `null`**（调用方应据此显示"未探测"
   *   而不是乐观地当成支持）
   */
  private capabilities(): Capabilities | null {
    return this.capsRaw === null ? null : createCapabilities(this.capsRaw);
  }

  /**
   * 生成"这次探测基于哪套 llama.cpp 目录"的标识。
   *
   * 用 `llama_dir` + `server_exe` 拼成字符串比较，比深比较配置对象简单，
   * 也足够覆盖"换目录/换 exe 就要重探"这一唯一需求。
   */
  private capsKeyFor(config: LauncherConfig): string {
    return `${config.llama_dir}|${config.server_exe ?? ""}`;
  }

  /**
   * 定出可执行的 `llama-server.exe` 路径。
   *
   * 顺序：配置里给的具体路径（且确实存在）→ 用 `llama_dir` 与当前目录做自动探测。
   *
   * @param config 当前配置
   * @returns exe 的完整路径；两轮都找不到时返回 `null`（调用方应提示用户手动指定）
   */
  private resolveExe(config: LauncherConfig): string | null {
    const direct = resolveServerExe(config);
    if (direct !== "" && existsSync(direct)) return direct;
    const discovered = discoverLlamaDir(this.searchStartDirs(config));
    return discovered === null ? null : join(discovered, "llama-server.exe");
  }

  // ------------------------------------------------------------------ 探测

  /**
   * 现场探测 llama-server 能力（跑 `--version` / `--help`），并缓存结果。
   *
   * 副作用：把解析到的 help 文本与"探测时的目录"记进实例，供 {@link preview} 复用。
   * 拿不到 help 文本时缓存被置空，后续拼命令行会退化成"大部分参数版本不支持"。
   *
   * @returns 探测结果载荷；找不到 exe 时返回 `{ error }` 而不是抛异常
   *   （这是可以展示给用户的正常情况）
   */
  async detect(): Promise<DetectPayload | ErrorPayload> {
    const exe = this.resolveExe(this.config);
    if (exe === null) {
      return {
        error: "找不到 llama-server.exe：请在界面里指定 llama.cpp 目录，或设置环境变量 LLAMA_DIR / LLAMA_SERVER",
      };
    }
    const probe = await probeServer(exe);
    this.capsRaw = probe.helpText.trim() === "" ? null : probe.helpText;
    this.capsKey = this.capsKeyFor(this.config);
    this.exe = exe;
    return buildDetectPayload(exe, probe);
  }

  // ------------------------------------------------------------------ 拼命令行

  /**
   * 拼出"按这份配置启动会是什么样"，**不启动任何进程**。
   *
   * 界面每次改参数都会调它（防抖），用返回值刷新命令行预览与决策表；
   * 也正因为它和 `start()` 共用 `prepareLaunch`，"看到的命令"才等于"启动的命令"。
   *
   * 关键行为：还没探测过、或 llama.cpp 目录变了时，会**先自动探测一次**
   * （界面因此不需要强迫用户先点"重新探测"）。
   *
   * @param config 当前配置
   * @returns 命令、决策表、presets 与告警；失败时返回 `{ error }`（含 exe 找不到、
   *   `prepareLaunch` 抛出的异常等）
   */
  async preview(config: LauncherConfig): Promise<PreviewPayload | ErrorPayload> {
    // 换了 llama.cpp 目录或还没探测过 → 先探测，否则拼出来的参数名可能是别的版本的名字
    if (this.capsRaw === null || this.capsKey !== this.capsKeyFor(config)) {
      this.config = config;
      const detected = await this.detect();
      if ("error" in detected) return detected;
    }
    try {
      const prepared = await prepareLaunch(config, { helpText: this.capsRaw ?? "" });
      const payload = buildPreviewPayload(prepared, config.models_preset ?? null);
      this.exe = prepared.exe;
      this.lastPreview = payload;
      return payload;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ------------------------------------------------------------------ 启动 / 停止

  /**
   * 启动 llama-server：先拼命令行 → 端口顺延 → 起进程 → 等端口监听。
   *
   * 几个刻意的处理：
   * - **端口顺延**：目标端口被占用时自动往后找空闲端口，并同步改写命令行里的 `--port`
   *   与预览载荷（这样界面上显示的仍是真正会用的端口），同时记一条告警说明改过
   * - **日志缓冲清零**：每次启动都从头记，避免上一次运行的日志混进这次的失败诊断
   * - **失败不抛异常**：起不来时返回带 `report.diagnosis` 的载荷，界面直接展示诊断结论
   *
   * @param config 当前配置
   * @returns 启动结果（含命令、决策表、报告与 baseUrl）；已有进程在运行或拼装失败时返回 `{ error }`
   */
  async start(config: LauncherConfig): Promise<StartPayload | ErrorPayload> {
    if (this.server.isRunning()) return { error: "已有 llama-server 在运行，请先停止" };

    let preview = await this.preview(config);
    if ("error" in preview) return preview;

    const { exe, host, env } = preview;
    let port = preview.port;
    let argv = preview.argv;

    // 端口被占用就顺延（与 PS1 的"被占用会自动顺延"一致）
    const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    if (await probeTcp(probeHost, port, 300)) {
      const occupied = port;
      const next = await findFreePort(probeHost, occupied + 1);
      const patched = [...argv];
      const idx = patched.indexOf("--port");
      if (idx !== -1) patched[idx + 1] = String(next);
      port = next;
      argv = patched;
      preview = {
        ...preview,
        port,
        argv,
        command: `${exe} ${formatArgv(patched)}`,
        warnings: [...preview.warnings, `端口 ${occupied} 已被占用，已自动改用 ${next}`],
      };
    }
    this.lastPreview = preview;

    // 环境自检：把「这份构建与这台机器匹配不匹配」的结论一并带进告警。
    // 只提示不拦截 —— 自检误判的代价（把用户挡住）比漏判（多一条警告）大得多。
    try {
      const report = await this.precheck();
      const lines = precheckWarnings(report);
      if (lines.length > 0) {
        preview = { ...preview, warnings: [...preview.warnings, ...lines] };
      }
    } catch {
      // 自检本身失败不该影响启动
    }

    this.logBuffer = [];
    this.logSeq = 0;

    const report = await this.server.start({
      exe,
      argv,
      host,
      port,
      env,
      onLine: (line, event) => {
        this.logSeq += 1;
        const push = toLogPush(this.logSeq, Date.now(), line, event);
        this.logBuffer.push(push);
        if (this.logBuffer.length > LOG_BUFFER_LIMIT) {
          this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_LIMIT);
        }
        this.events.onLog?.(push);
        // 日志里带 tok/s 时顺手喂给采样器，界面上的吞吐曲线就有数据了
        this.metricsSampler().noteThroughput(event.metrics);
      },
      onState: (state, note) => {
        this.metricsSampler().setServerState(state);
        this.events.onState?.({ state, note, health: null });
      },
    });

    return { ...preview, report: buildStartReport(report), baseUrl: baseUrlFor(config, host, port) };
  }

  /**
   * 停止 llama-server（含 taskkill 兜底，见 `LlamaServer.stop`）。
   *
   * 界面退出前也会调它 —— 否则会留下占着显存的孤儿进程。
   *
   * @returns 固定 `{ ok: true }`；停止本身不抛异常（没有进程时也视为成功）
   */
  async stop(): Promise<{ ok: boolean }> {
    await this.server.stop();
    // 端口空出来了，自检里的「端口空闲」结论需要重算
    this.invalidatePrecheck();
    return { ok: true };
  }

  /**
   * 用**当前已加载的配置**启动。
   *
   * 给没有界面入参的调用方用（托盘菜单、未来的快捷键）：
   * 它们手里没有 config 对象，而会话一直持有最新的一份。
   *
   * @returns 与 {@link start} 相同的载荷
   */
  async startCurrent(): Promise<StartPayload | ErrorPayload> {
    return this.start(this.config);
  }

  // ------------------------------------------------------------------ 状态

  /**
   * 推导当前应该访问的 base URL。
   *
   * 优先用**上次预览/启动实际使用**的 host 与 port（它们可能因端口顺延而不同于配置），
   * 没有预览结果时才退回配置值。
   */
  private currentBaseUrl(): string {
    const host = this.lastPreview?.host ?? this.config.host ?? "127.0.0.1";
    const port = this.lastPreview?.port ?? (typeof this.config.port === "number" ? this.config.port : 8080);
    return baseUrlFor(this.config, host, port);
  }

  /**
   * 查一次 `/health`。
   *
   * 超时给得比其他调用短（1500ms）：界面每 2 秒轮询一次状态，
   * 健康检查不该把轮询节奏拖长。
   *
   * @returns 健康状态；`loading` = 服务在监听但模型还没加载完（正常中间态）
   */
  async health(): Promise<HealthPayload> {
    const result = await fetchHealth(this.currentBaseUrl(), 1500);
    return { state: result.state, httpStatus: result.httpStatus, detail: result.detail };
  }

  /**
   * 汇总当前状态给界面轮询（状态徽标、PID、baseUrl、健康状态、最近用的命令）。
   *
   * 只有进程在跑时才真的去请求 `/health`（否则白等一个必然失败的请求）；
   * 未运行时 `health` 为 `null`，界面据此不显示健康徽标。
   *
   * @returns 状态载荷，见 {@link StatusPayload}
   */
  async status(): Promise<StatusPayload> {
    const running = this.server.isRunning();
    return {
      state: this.server.getState(),
      note: this.server.getStateNote(),
      pid: this.server.getPid(),
      running,
      baseUrl: this.currentBaseUrl(),
      health: running ? await this.health() : null,
      lastCommand: this.lastPreview?.command ?? null,
    };
  }

  /**
   * 同步汇报"服务是否还活着"。
   *
   * 专门给关窗路径用：那里需要**立刻**知道要不要提示用户，而 `status()` 会去请求 `/health`
   * （服务卡住时可能等好几秒，关窗口不该等网络）。
   *
   * `starting` / `running` / `stopping` 都算"活着"：启动中直接退会把刚加载的模型扔掉，
   * 停止中再插一次退出也可能打断清理。
   *
   * @returns `active` 为是否活着，附当前状态与 PID（PID 可能为 `null`）
   */
  servingSummary(): { active: boolean; state: ServerState; pid: number | null } {
    const state = this.server.getState();
    return {
      active: state === "starting" || state === "running" || state === "stopping",
      state,
      pid: this.server.getPid(),
    };
  }

  /**
   * 取已缓存的日志（界面刚加载时用来补上历史输出）。
   *
   * @returns 日志条目副本（新数组，界面改动不会影响内部缓冲）
   */
  recentLogs(): LogPush[] {
    return [...this.logBuffer];
  }

  /**
   * 跑一遍环境自检（驱动/CUDA 运行时/模型/端口），结果按配置缓存。
   *
   * 缓存键包含 exe、模型路径、端口与 presets 路径 —— 这些一变就重新自检；
   * 另外服务启停时也会作废（端口占用状态会变）。
   *
   * @param force 忽略缓存强制重跑（界面上的「重新自检」按钮）
   * @returns 自检报告；失败时返回一份"只有一条 error"的报告，而不是抛异常
   */
  async precheck(force = false): Promise<PrecheckReport> {
    const exe = this.resolveExe(this.config);
    const key = this.precheckKeyFor(exe);
    if (!force && this.lastPrecheck !== null && this.precheckKey === key) return this.lastPrecheck;

    if (exe === null) {
      const report: PrecheckReport = {
        at: Date.now(),
        verdict: "error",
        items: [
          {
            id: "exe",
            level: "error",
            title: "找不到 llama-server.exe",
            detail: "无法确定要检查哪份构建。",
            suggestion: "在界面里指定 llama.cpp 目录，或设置环境变量 LLAMA_DIR / LLAMA_SERVER。",
          },
        ],
        facts: {
          exe: "",
          exeExists: false,
          coreDllMissing: [],
          backends: [],
          cudaRuntimeDlls: [],
          cudaRequiredMajor: null,
          needsDriver: false,
          missingRuntimeDlls: [],
          driverVersion: null,
          driverMaxCuda: null,
          gpuName: null,
          vramTotalMiB: null,
          modelPath: null,
          modelSizeMiB: null,
          modelMagicOk: null,
          portFree: null,
          presetPathNonAscii: false,
        },
      };
      this.lastPrecheck = report;
      this.precheckKey = key;
      return report;
    }

    const report = await runPrecheck({ config: this.config, exe });
    this.lastPrecheck = report;
    this.precheckKey = key;
    return report;
  }

  /** 自检缓存键：这些字段决定了自检结论，任一变化就要重跑 */
  private precheckKeyFor(exe: string | null): string {
    return [
      exe ?? "",
      String(this.config.mode ?? "single"),
      String(this.config.main_model ?? ""),
      String(this.config.models_dir ?? ""),
      String(this.config.preload_model ?? ""),
      String(this.config.models_preset ?? ""),
      String(this.config.port ?? ""),
    ].join("|");
  }

  /** 作废自检缓存（服务启停后端口占用状态会变） */
  private invalidatePrecheck(): void {
    this.lastPrecheck = null;
    this.precheckKey = "";
  }

  /**
   * 取进程最近若干行**原始**日志文本（未分类），用于"查看原始输出"。
   *
   * @param count 取最后多少行，默认 50
   * @returns 原始行数组；没启动过进程时为空数组
   */
  recentLines(count = 50): string[] {
    return this.server.recentLines(count);
  }

  // ------------------------------------------------------------------ 指标监控（M3）

  /**
   * 取指标采样器（懒创建）。
   *
   * 主卡序号取自配置的 `main_gpu`（多卡时用户可能希望盯第二张卡）。
   * 注意：创建对象不会起定时器，只有 {@link watchMetrics}(true) 才会开始采样。
   * 每次采样后会推**完整载荷**（含历史序列），界面拿到直接替换即可，不必自己攒数据。
   */
  private metricsSampler(): MetricsSampler {
    if (this.sampler === null) {
      const sampler = new MetricsSampler({
        mainGpuIndex: this.mainGpuIndex(),
        onSample: () => this.events.onMetrics?.(this.metricsPayload(sampler)),
      });
      this.sampler = sampler;
    }
    return this.sampler;
  }

  /** 把采样器的当前状态打包成给界面的载荷 */
  private metricsPayload(sampler: MetricsSampler): MetricsPayload {
    return {
      latest: sampler.latest(),
      series: sampler.series(),
      running: sampler.isRunning(),
      gpuError: sampler.gpuError(),
    };
  }

  /** 解析配置里的 `main_gpu`：可能是数字也可能是字符串，解析不出就当 0 号卡 */
  private mainGpuIndex(): number {
    const raw = this.config.main_gpu;
    const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  /**
   * 取一次指标快照（含历史序列），界面首次绘制监控页时用。
   *
   * @returns 最近采样、历史序列、采样器是否在跑、GPU 采集失败原因
   */
  async metricsSnapshot(): Promise<MetricsPayload> {
    return this.metricsPayload(this.metricsSampler());
  }

  /**
   * 开关实时指标采样。
   *
   * 界面切到「监控」页时开、离开时关 —— 每秒起一个 nvidia-smi 进程是实打实的开销，
   * 没人看的时候不该烧。历史不会被清空，切回来还能看到之前的曲线。
   *
   * @param active 是否开始采样
   * @returns `running` 为开关之后的实际状态
   */
  watchMetrics(active: boolean): { ok: boolean; running: boolean } {
    const sampler = this.metricsSampler();
    if (active) sampler.start();
    else sampler.stop();
    return { ok: true, running: sampler.isRunning() };
  }

  // ------------------------------------------------------------------ 配置档案（M3）

  /** 档案目录：与当前配置文件同级的 `profiles/`，方便用户直接去那儿拷文件 */
  profilesDir(): string {
    return join(dirname(this.configPath), "profiles");
  }

  /**
   * 列出全部档案（按最后修改时间从新到旧）。
   *
   * @returns 档案目录与档案数组；目录还不存在时数组为空
   */
  listProfiles(): ProfilesPayload {
    const dir = this.profilesDir();
    return { dir, profiles: listProfileFiles(dir) };
  }

  /**
   * 把一份配置存成档案。
   *
   * 档案名会被规整成安全文件名（非法字符替换、目录穿越无效化），同名则覆盖。
   *
   * @param name 档案名（用户输入，不必是安全名）
   * @param config 要保存的配置（通常是界面当前这份，可能还没存盘）
   * @returns 保存后的档案列表与实际写入的档案名
   */
  saveProfile(name: string, config: LauncherConfig): { ok: boolean; profiles: ProfileInfo[]; saved: string } {
    const saved = saveProfileFile(this.profilesDir(), name, config);
    return { ok: true, profiles: this.listProfiles().profiles, saved: saved.name };
  }

  /**
   * 载入一个档案：读文件 → 归一化 → **把它设为当前配置**。
   *
   * 之所以连 `configPath` 一起切过去：这样界面上的「保存」会写回这套档案，
   * 符合"载入档案 = 开始用这套配置"的直觉。
   *
   * @param name 档案名
   * @returns 新的初始化载荷（结构与换配置一致）；档案不存在或读不出来时 `payload` 为当前状态并附告警
   */
  loadProfile(name: string): ProfileLoadResult {
    const path = profilePath(this.profilesDir(), name);
    try {
      const loaded = readProfileFile(path);
      this.configPath = path;
      this.config = loaded.config;
      this.configWarnings = loaded.warnings;
      this.invalidateCapabilities();
      const payload = this.bootstrapPayload();
      return { canceled: false, name, path, payload, warnings: loaded.warnings };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const payload = this.bootstrapPayload();
      return {
        canceled: false,
        name,
        path: null,
        payload,
        warnings: [`载入档案「${name}」失败：${reason}`],
      };
    }
  }

  /**
   * 删除一个档案（幂等：文件已不存在也算成功）。
   *
   * 边界：若删的正是当前正在用的那套档案，**不改动当前配置**（内存里的配置照常可用，
   * 只是"保存"会重新把它写出来）—— 删文件顺手清空界面上的参数会让人措手不及。
   *
   * @param name 档案名
   * @returns 删除后的档案列表
   */
  deleteProfile(name: string): { ok: boolean; profiles: ProfileInfo[] } {
    deleteProfileFile(this.profilesDir(), name);
    return { ok: true, profiles: this.listProfiles().profiles };
  }
}
