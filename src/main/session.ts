/**
 * 会话状态机 —— 「当前配置 + 探测结果 + 命令行预览 + 运行中的进程」都收敛在这里。
 *
 * 刻意**不 import electron**：主进程只负责窗口与对话框，业务逻辑全在这个类里，
 * 于是它可以被 CLI、被单测直接驱动，而不是只能通过点界面来验证。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatArgv } from "../core/args.ts";
import { DEFAULT_CONFIG, discoverLlamaDir, loadConfigFile, normalizeConfig, resolveServerExe, saveConfigFile } from "../core/config.ts";
import { fetchHealth, findFreePort, probeTcp } from "../core/health.ts";
import { createCapabilities } from "../core/helpProbe.ts";
import { prepareLaunch, probeServer } from "../core/launcher.ts";
import { LlamaServer } from "../core/llamaProcess.ts";
import type { Capabilities, LauncherConfig } from "../core/types.ts";
import type {
  BootstrapPayload,
  DetectPayload,
  ErrorPayload,
  HealthPayload,
  LogPush,
  PreviewPayload,
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
  private events: SessionEvents;

  /**
   * @param configPath 配置文件路径；文件不存在也不会报错，会退化成默认配置并给出告警
   * @param events 日志与状态的回调，见 {@link SessionEvents}
   */
  constructor(configPath: string, events: SessionEvents = {}) {
    this.configPath = configPath;
    this.events = events;
  }

  // ------------------------------------------------------------------ 配置

  /**
   * 启动时拉一次初始状态：读配置 + 打包成界面需要的载荷。
   *
   * @returns 配置路径、归一化配置、参数表与告警，见 {@link BootstrapPayload}
   */
  bootstrap(): BootstrapPayload {
    this.reloadConfig();
    return this.bootstrapPayload();
  }

  /**
   * 从磁盘重读配置。
   *
   * 边界：**配置文件不存在不算错误** —— 这是首次运行的正常情况。
   * 此时退回默认配置，并尝试自动探测 llama.cpp 目录，把结果写进告警提示用户。
   */
  private reloadConfig(): void {
    if (!existsSync(this.configPath)) {
      const discovered = discoverLlamaDir([process.cwd()]);
      this.config = { ...DEFAULT_CONFIG, llama_dir: discovered ?? "" };
      this.configWarnings = [
        `配置文件不存在（${this.configPath}），已使用默认值` +
          (discovered === null ? "；也没能自动探测到 llama.cpp 目录，请在界面里指定" : `；已自动探测到 ${discovered}`),
      ];
      return;
    }
    const loaded = loadConfigFile(this.configPath);
    this.config = loaded.config;
    this.configWarnings = loaded.warnings;
  }

  /** 把当前会话状态打包成界面初始化所需的载荷（含参数表与支持情况） */
  private bootstrapPayload(): BootstrapPayload {
    return {
      configPath: this.configPath,
      config: this.config,
      warnings: this.configWarnings,
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
   * 导入 v1.9（原版启动器）的配置：迁移字段、保留未知键，并落到新文件。
   *
   * 输出文件名固定为源文件同目录下的 `llama-launcher.json`（不覆盖源文件），
   * 迁移后本会话即切换到这个新文件。
   *
   * @param path 原版启动器的 `llama_launcher_config.json` 路径
   * @returns 新的初始化载荷，`warnings` 里含迁移说明与全部归一化告警
   * @throws {Error} 源文件读不到或不是合法 JSON 时抛出（由 `readFileSync` / `JSON.parse` 抛出）
   */
  migrateFrom(path: string): BootstrapPayload {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const { config, warnings } = normalizeConfig(raw);
    const target = join(dirname(path), "llama-launcher.json");
    saveConfigFile(target, config);
    this.configPath = target;
    this.invalidateCapabilities();
    const payload = this.bootstrapPayload();
    return { ...payload, warnings: [`已从 ${path} 迁移，未知键已保留`, ...warnings, ...payload.warnings] };
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
    const discovered = discoverLlamaDir([process.cwd(), config.llama_dir].filter((d) => d !== ""));
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
      },
      onState: (state, note) => {
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
    return { ok: true };
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
   * 取已缓存的日志（界面刚加载时用来补上历史输出）。
   *
   * @returns 日志条目副本（新数组，界面改动不会影响内部缓冲）
   */
  recentLogs(): LogPush[] {
    return [...this.logBuffer];
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
}
