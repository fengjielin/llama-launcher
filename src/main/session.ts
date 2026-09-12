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

const LOG_BUFFER_LIMIT = 4000;

export interface SessionEvents {
  onLog?: (entry: LogPush) => void;
  onState?: (push: StatePush) => void;
}

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

  constructor(configPath: string, events: SessionEvents = {}) {
    this.configPath = configPath;
    this.events = events;
  }

  // ------------------------------------------------------------------ 配置

  bootstrap(): BootstrapPayload {
    this.reloadConfig();
    return this.bootstrapPayload();
  }

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

  openConfig(path: string): BootstrapPayload {
    this.configPath = path;
    this.invalidateCapabilities();
    this.reloadConfig();
    return this.bootstrapPayload();
  }

  /** 导入 v1.9（原版启动器）配置：迁移字段、保留未知键，落到新文件 */
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

  getConfigPath(): string {
    return this.configPath;
  }

  private invalidateCapabilities(): void {
    this.capsRaw = null;
    this.capsKey = "";
  }

  private capabilities(): Capabilities | null {
    return this.capsRaw === null ? null : createCapabilities(this.capsRaw);
  }

  private capsKeyFor(config: LauncherConfig): string {
    return `${config.llama_dir}|${config.server_exe ?? ""}`;
  }

  private resolveExe(config: LauncherConfig): string | null {
    const direct = resolveServerExe(config);
    if (direct !== "" && existsSync(direct)) return direct;
    const discovered = discoverLlamaDir([process.cwd(), config.llama_dir].filter((d) => d !== ""));
    return discovered === null ? null : join(discovered, "llama-server.exe");
  }

  // ------------------------------------------------------------------ 探测

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

  async stop(): Promise<{ ok: boolean }> {
    await this.server.stop();
    return { ok: true };
  }

  // ------------------------------------------------------------------ 状态

  private currentBaseUrl(): string {
    const host = this.lastPreview?.host ?? this.config.host ?? "127.0.0.1";
    const port = this.lastPreview?.port ?? (typeof this.config.port === "number" ? this.config.port : 8080);
    return baseUrlFor(this.config, host, port);
  }

  async health(): Promise<HealthPayload> {
    const result = await fetchHealth(this.currentBaseUrl(), 1500);
    return { state: result.state, httpStatus: result.httpStatus, detail: result.detail };
  }

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

  recentLogs(): LogPush[] {
    return [...this.logBuffer];
  }

  recentLines(count = 50): string[] {
    return this.server.recentLines(count);
  }
}
