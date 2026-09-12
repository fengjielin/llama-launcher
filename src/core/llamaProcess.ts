/**
 * llama-server 进程生命周期管理。
 *
 * 状态机： idle → starting → running → stopping → exited / failed
 *
 * Windows 上的三个必须处理项：
 *   1. `windowsHide: true`，否则每次启动都闪一个黑色控制台窗口；
 *   2. stdio 用 pipe 才拿得到日志（行缓冲在 logLines.ts 里做）；
 *   3. 停止时先 kill，超时后用 `taskkill /T /F` 兜底杀整棵进程树 ——
 *      否则 llama-server 被 kill 后可能留下占着显存的孤儿进程。
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { classify, diagnose, LineSplitter } from "./logLines.ts";
import type { Diagnosis, LogEvent } from "./logLines.ts";
import { waitForTcp } from "./health.ts";
import { fetchHealth } from "./health.ts";
import type { HealthResult } from "./health.ts";

export type ServerState = "idle" | "starting" | "running" | "stopping" | "exited" | "failed";

export interface StartOptions {
  exe: string;
  argv: string[];
  host: string;
  port: number;
  env?: Record<string, string>;
  cwd?: string;
  /** 等待端口监听的超时（默认 90s，与 PS1 的浏览器等待窗口一致） */
  readyTimeoutMs?: number;
  maxLogLines?: number;
  onLine?: (line: string, event: LogEvent) => void;
  onState?: (state: ServerState, note: string) => void;
}

export interface StartReport {
  pid: number | null;
  ready: boolean;
  waitedMs: number;
  state: ServerState;
  note: string;
  diagnosis: Diagnosis | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 杀整棵进程树（Windows 下 kill 只杀父进程） */
async function killTree(pid: number): Promise<void> {
  if (process.platform !== "win32") return;
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("exit", () => resolve());
    killer.once("error", () => resolve());
  });
}

export class LlamaServer {
  private child: ChildProcess | null = null;
  private splitter = new LineSplitter();
  private lines: string[] = [];
  private state: ServerState = "idle";
  private stateNote = "";
  private opts: StartOptions | null = null;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private spawnError: Error | null = null;

  getState(): ServerState {
    return this.state;
  }

  getStateNote(): string {
    return this.stateNote;
  }

  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  isRunning(): boolean {
    return this.child !== null && this.exitInfo === null;
  }

  /** 已经退出了吗（含 spawn 直接失败） */
  hasExited(): boolean {
    return this.exitInfo !== null || this.spawnError !== null;
  }

  /**
   * 这两个字段只在事件回调里被赋值，TS 的控制流分析会坚持认为它们恒为 null
   * （于是 `!== null` 分支被推成 never）。用方法取一次就能绕开这个误判。
   */
  private spawnFailure(): Error | null {
    return this.spawnError;
  }

  private exitState(): { code: number | null; signal: string | null } | null {
    return this.exitInfo;
  }

  recentLines(n = 200): string[] {
    return this.lines.slice(-n);
  }

  private setState(state: ServerState, note: string): void {
    this.state = state;
    this.stateNote = note;
    this.opts?.onState?.(state, note);
  }

  private handleLine(line: string): void {
    const event = classify(line);
    this.lines.push(line);
    const max = this.opts?.maxLogLines ?? 2000;
    if (this.lines.length > max) this.lines.splice(0, this.lines.length - max);
    this.opts?.onLine?.(line, event);
  }

  async start(opts: StartOptions): Promise<StartReport> {
    if (this.child !== null) throw new Error("已有 llama-server 进程在运行，请先调用 stop()");

    this.opts = opts;
    this.splitter = new LineSplitter();
    this.lines = [];
    this.exitInfo = null;
    this.spawnError = null;
    this.setState("starting", `正在启动 ${opts.exe}`);

    const child = spawn(opts.exe, opts.argv, {
      cwd: opts.cwd ?? dirname(opts.exe),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    this.child = child;

    const pump = (chunk: Buffer): void => {
      for (const line of this.splitter.push(chunk.toString("utf8"))) this.handleLine(line);
    };
    child.stdout?.on("data", pump);
    child.stderr?.on("data", pump);

    child.on("error", (err) => {
      this.spawnError = err;
      this.setState("failed", `无法启动进程：${err.message}`);
    });

    child.on("exit", (code, signal) => {
      for (const line of this.splitter.flush()) this.handleLine(line);
      this.exitInfo = { code, signal };
      if (this.state === "stopping") {
        this.setState("exited", "已停止");
      } else {
        this.setState("failed", `进程退出（code=${code}${signal ? `, signal=${signal}` : ""}）`);
      }
    });

    const wait = await waitForTcp({
      host: opts.host,
      port: opts.port,
      timeoutMs: opts.readyTimeoutMs ?? 90_000,
      hasExited: () => this.hasExited(),
    });

    if (wait.ok) {
      const note = `端口已监听（等待 ${wait.waitedMs} ms）`;
      this.setState("running", note);
      return { pid: child.pid ?? null, ready: true, waitedMs: wait.waitedMs, state: this.state, note, diagnosis: null };
    }

    const diagnosis = diagnose(this.lines);
    const spawnError = this.spawnFailure();
    const exitInfo = this.exitState();
    let note: string;
    if (spawnError !== null) {
      note = `进程启动失败：${spawnError.message}`;
    } else if (wait.reason === "exited") {
      note = `进程在监听端口前就退出了（code=${exitInfo === null ? "?" : String(exitInfo.code)}）`;
    } else {
      note = `等待 ${wait.waitedMs} ms 仍未监听端口 ${opts.host}:${opts.port}`;
    }
    this.setState("failed", note);
    return { pid: child.pid ?? null, ready: false, waitedMs: wait.waitedMs, state: this.state, note, diagnosis };
  }

  /** 查一次 /health（503 表示服务在、模型还没加载） */
  async health(timeoutMs = 2000): Promise<HealthResult> {
    const host = this.opts?.host ?? "127.0.0.1";
    const port = this.opts?.port ?? 8080;
    const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return fetchHealth(`http://${h}:${port}`, timeoutMs);
  }

  /** 停止：先 kill，超时后 taskkill /T /F 杀整棵树 */
  async stop(graceMs = 5000): Promise<void> {
    const child = this.child;
    if (child === null) {
      this.setState("idle", "没有正在运行的进程");
      return;
    }
    const pid = child.pid;
    this.setState("stopping", "正在停止");

    const exited = new Promise<void>((resolve) => {
      if (this.exitInfo !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });

    try {
      child.kill();
    } catch {
      // 已经退出了
    }

    const timedOut = await Promise.race([exited.then(() => false), delay(graceMs).then(() => true)]);
    if (timedOut && typeof pid === "number") {
      await killTree(pid);
      await Promise.race([exited, delay(3000)]);
    }

    this.child = null;
    if (this.state !== "exited") this.setState("exited", "已停止");
  }
}

/**
 * 跑一次性命令并收全输出（用于 `--help` / `--version` 探测）。
 * 注意：探测必须在启动前做 —— 参数名随版本漂移，猜错会直接启动失败。
 */
export function runCapture(
  exe: string,
  args: readonly string[],
  timeoutMs = 20_000,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(exe, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    const finish = (payload: { code: number | null; stdout: string; stderr: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({ code: null, stdout, stderr, error: `执行超时（${timeoutMs} ms）：${exe} ${args.join(" ")}` });
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr, error: `无法执行 ${exe}：${err.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr });
    });
  });
}
