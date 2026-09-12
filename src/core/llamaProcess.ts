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

/**
 * 进程状态机的状态取值。
 *
 * 正常流转：`idle → starting → running → stopping → exited`。
 * 任何阶段都可能直接进 `failed`（spawn 失败、非预期退出、等不到端口）。
 * `running` 的含义是**端口已开始监听**，不代表模型已经加载完
 * （router 模式下模型是按需加载的，要另外看 `/health`）。
 */
export type ServerState = "idle" | "starting" | "running" | "stopping" | "exited" | "failed";

/** {@link LlamaServer.start} 的入参 */
export interface StartOptions {
  /** `llama-server.exe` 的完整路径 */
  exe: string;
  /** 命令行参数（不含 exe 自身），由 `buildArgs` 产出 */
  argv: string[];
  /** 监听地址，用于判断"端口起来了没有" */
  host: string;
  /** 监听端口，同上 */
  port: number;
  /** 附加环境变量，会覆盖 `process.env` 里的同名项（如思考开关的 kwargs） */
  env?: Record<string, string>;
  /** 工作目录，默认取 exe 所在目录 —— llama.cpp 的 DLL 就在那儿，换目录会起不来 */
  cwd?: string;
  /** 等待端口监听的超时（默认 90s，与 PS1 的浏览器等待窗口一致） */
  readyTimeoutMs?: number;
  /** 内存里保留多少行日志用于失败诊断，默认 2000 */
  maxLogLines?: number;
  /** 每收到一行日志回调一次（含分类结果），界面用它做实时展示 */
  onLine?: (line: string, event: LogEvent) => void;
  /** 状态变化回调，用于刷新界面上的状态徽标 */
  onState?: (state: ServerState, note: string) => void;
}

/**
 * {@link LlamaServer.start} 的结果。
 *
 * 注意：**启动失败不抛异常**，而是返回 `ready: false` + `note` + 可能的 `diagnosis`，
 * 因为"起不来"是需要展示给用户的正常结果，而不是程序错误。
 */
export interface StartReport {
  /** 子进程 PID；spawn 阶段就失败时为 `null` */
  pid: number | null;
  /** 是否已在 `readyTimeoutMs` 内监听端口 */
  ready: boolean;
  /** 实际等待时长（毫秒） */
  waitedMs: number;
  /** 结束时的状态：成功为 `running`，失败为 `failed` */
  state: ServerState;
  /** 面向用户的一句话说明（成功说明等了多久，失败说明原因） */
  note: string;
  /** 在已收集的日志里诊断出的失败原因；识别不出或启动成功时为 `null` */
  diagnosis: Diagnosis | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 强行杀掉整棵进程树（Windows 下 `child.kill()` 只杀父进程）。
 *
 * 为什么需要：llama-server 被 kill 后若有残留子进程，它会继续占着显存，
 * 表现为"关掉界面后显存莫名没释放、下次启动就 OOM"。
 * 因此 `stop()` 在优雅终止超时后用它兜底。
 *
 * 边界：非 Windows 平台直接返回（类 Unix 下 kill 会连带到进程组）；
 * taskkill 不存在或失败也只当作"尽力而为"，**永不抛异常**。
 *
 * @param pid 目标进程 PID
 */
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

/**
 * 管理一个 llama-server 子进程的完整生命周期。
 *
 * 一个实例对应一次启动：`start()` → 用完 `stop()`，之后可以再次 `start()`。
 * 内部维护三份状态：
 * - `state` / `stateNote`：对外展示的状态机（见 {@link ServerState}）
 * - `lines`：最近的日志行（环形裁剪到 `maxLogLines`），启动失败时用它做诊断
 * - `exitInfo` / `spawnError`：进程怎么结束的，用于区分"我停的"与"它自己崩的"
 *
 * 线程/时序注意：`exitInfo` 与 `spawnError` 只在事件回调里赋值，
 * 因此不能用字段本身做同步判断（TS 也会因此误判类型），统一走私有读取方法。
 */
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

  /** 进程是否还活着（已退出、或 spawn 直接失败都算不活着） */
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

  /**
   * 取最近若干行日志（启动失败时用于诊断，也可用于界面上"查看原始输出"）。
   *
   * @param n 取最后多少行，默认 200；不足时返回全部
   * @returns 日志行副本（新数组，调用方改动不会影响内部缓冲）
   */
  recentLines(n = 200): string[] {
    return this.lines.slice(-n);
  }

  /** 更新状态并通知外部回调（`onState` 是可选的，没传就只改内部状态） */
  private setState(state: ServerState, note: string): void {
    this.state = state;
    this.stateNote = note;
    this.opts?.onState?.(state, note);
  }

  /**
   * 处理一行日志：分类 → 存入环形缓冲 → 透传给外部回调。
   *
   * 缓冲按 `maxLogLines`（默认 2000）裁剪，只保留最近的行 ——
   * 目的是失败诊断有素材可用，同时避免长时间运行把内存吃光。
   */
  private handleLine(line: string): void {
    const event = classify(line);
    this.lines.push(line);
    const max = this.opts?.maxLogLines ?? 2000;
    if (this.lines.length > max) this.lines.splice(0, this.lines.length - max);
    this.opts?.onLine?.(line, event);
  }

  /**
   * 启动 llama-server，并等到端口开始监听（或判定失败）。
   *
   * 流程：重置内部状态 → spawn → 把 stdout/stderr 都接到同一个行缓冲泵上 →
   * 轮询 TCP 等待端口 → 依结果置为 `running` 或 `failed`。
   *
   * 关键设计与边界：
   * - `cwd` 默认取 exe 所在目录：llama.cpp 的 DLL 就在旁边，换目录会起不来
   * - stdout 与 **stderr 都要接**：llama.cpp 的提示与报错分散在两个流里
   * - `env` 是**追加覆盖**（`{...process.env, ...opts.env}`），不是替换，
   *   否则子进程会丢掉 PATH 等必需变量
   * - 判"起来没有"用 TCP 连通性而不是 `/health`：router 模式下模型没加载时
   *   `/health` 返回 503，用它判断会误判成失败
   * - **启动失败不抛异常**：返回 `ready: false`，并在已收集的日志里跑一次诊断
   *   （显存不足、端口占用等），把结论放进 `diagnosis` 供界面直接展示
   *
   * @param opts 启动参数与回调，见 {@link StartOptions}
   * @returns 启动结果（含 PID、是否就绪、等待时长、失败诊断），见 {@link StartReport}
   * @throws {Error} 该实例已有进程在运行时抛出 —— 这是调用方的用法错误，
   *   与"进程起不来"是两回事，所以用抛错而不是返回 `ready: false`
   */
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

  /**
   * 查一次 `/health`。
   *
   * 用 `start()` 时记录的 host/port；`0.0.0.0` 这类"监听所有网卡"的地址
   * 会被换成本机回环地址，否则请求发不出去。
   *
   * @param timeoutMs 请求超时毫秒数，默认 2000
   * @returns 健康状态；`loading` 表示服务在监听但模型还没加载完（正常中间态）
   */
  async health(timeoutMs = 2000): Promise<HealthResult> {
    const host = this.opts?.host ?? "127.0.0.1";
    const port = this.opts?.port ?? 8080;
    const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return fetchHealth(`http://${h}:${port}`, timeoutMs);
  }

  /**
   * 停止进程：先优雅终止，超时再用 `taskkill /T /F` 杀整棵树。
   *
   * 为什么要分两级：Windows 上 `child.kill()` 是硬终止（没有 SIGINT 可发），
   * 但多数情况下它就已经够了；只有在它卡住（例如正在写大文件或驱动层未响应）时
   * 才需要 taskkill 兜底 —— 而**必须兜底**，否则会留下占着显存的孤儿进程。
   *
   * 边界与幂等性：
   * - 没有进程时直接置为 `idle` 并返回，**不抛异常**
   * - 若进程早已退出（`exitInfo` 不为空），不会重复等待
   * - 调用后 `this.child` 置空，允许随后重新 `start()`
   * - 全程**永不抛异常**（`kill()` 的异常被吞掉，因为那种情况通常是"已经退了"）
   *
   * @param graceMs 优雅终止的等待毫秒数，默认 5000；超时才动用 taskkill
   */
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
 * 跑一次性命令并收全输出。
 *
 * 用途是启动前的能力探测（`--help` / `--version`）—— 参数名随版本漂移，
 * 猜错会直接导致启动失败，所以必须先问一次。
 *
 * 边界与保证：
 * - 用 `settled` 标志保证**只结算一次**：超时、error、exit 三个事件可能竞争
 * - 超时会主动 kill 子进程，并返回 `code: null` + `error` 说明，而不是一直挂着
 * - 子进程起不来（exe 不存在等）走 `error` 字段返回，**不抛异常**
 * - stdout / stderr **分开收集**，由调用方决定怎么拼接（llama.cpp 的版本横幅历史
 *   上走过 stderr，只读 stdout 会拿到空字符串）
 *
 * @param exe 要执行的程序完整路径
 * @param args 参数列表
 * @param timeoutMs 超时毫秒数，默认 20_000
 * @returns `stdout` / `stderr` 为收集到的输出，`code` 为退出码（超时或失败为 `null`），
 *   `error` 仅在超时或无法执行时存在
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
