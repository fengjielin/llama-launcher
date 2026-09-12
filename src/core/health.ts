/**
 * 就绪探测。
 *
 * 关键实测结论（来自 llama-oneclick.ps1，别踩第二次）：
 *   router 模式下模型还没加载时，`/health` 会返回 **503**。
 *   把 503 当失败 → 浏览器永远打不开。所以：
 *     - 503 = 服务已起来，模型还没加载（"loading"）
 *     - 200 = 完全就绪（"ready"）
 *     - 连接被拒 = 进程还没监听（"unreachable"）
 *   判断"能不能开网页"要用 TCP 连通性，不要用 /health 的 HTTP 状态码。
 */

import { connect } from "node:net";

/**
 * 服务健康状态。
 *
 * - `ready`：`/health` 返回 200，服务可用（router 模式下模型可能仍是按需加载，不代表模型已就绪）
 * - `loading`：`/health` 返回 503，服务在监听但模型还没加载完 —— **这是正常中间态，不是故障**
 * - `error`：`/health` 返回了 200/503 之外的状态码
 * - `unreachable`：连接被拒 / 超时 / DNS 失败，服务根本没起来
 */
export type HealthState = "ready" | "loading" | "error" | "unreachable";

/** {@link fetchHealth} 的返回值；除 `state` 外其余字段都只在特定分支才有值 */
export interface HealthResult {
  state: HealthState;
  /** HTTP 状态码；`unreachable` 时没有（压根没拿到响应） */
  httpStatus?: number;
  /** 响应正文；读取失败时退化为空串 */
  body?: string;
  /** 人类可读的补充说明，`unreachable` / `error` 时用于展示原因 */
  detail?: string;
}

/**
 * 探测某个 TCP 端口是否可以建连 —— 这是判断「llama-server 起来没有」最可靠的信号。
 *
 * 之所以不用 `/health` 判断：router 模式下模型没加载时 `/health` 返回 503，
 * 会被 HTTP 客户端当成异常，导致"服务其实已经好了但界面一直打不开网页"。
 *
 * 本函数**永不抛异常**：连接被拒、超时、DNS 失败等一律返回 `false`。
 * 内部用 `settled` 标志保证多个事件里只结算一次（connect 与 timeout 可能同时到）。
 *
 * @param host 目标地址，如 `127.0.0.1`
 * @param port 目标端口
 * @param timeoutMs 建连超时毫秒数，默认 800；轮询场景下传小一点避免拖慢节奏
 * @returns 建连成功返回 `true`，其余情况返回 `false`
 */
export function probeTcp(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * 把「监听地址 + 端口」拼成可访问的 base URL。
 *
 * 边界：`0.0.0.0` / `::` 表示监听所有网卡，本机访问必须换成 `127.0.0.1`，
 * 否则部分客户端会连不上或走错网卡。
 *
 * @param host 配置里的监听地址
 * @param port 端口号
 * @returns 形如 `http://127.0.0.1:8080` 的地址（不带结尾斜杠）
 */
export function baseUrlOf(host: string, port: number): string {
  // 0.0.0.0 是"监听所有网卡"，本机访问要走 127.0.0.1
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${h}:${port}`;
}

/**
 * 请求 `/health` 并把状态码翻译成 {@link HealthState}。
 *
 * 本函数**永不抛异常**（这是刻意设计：健康检查失败本身就是一种需要展示的结果）：
 * 网络错误统一归为 `unreachable` 并把原始错误放进 `detail`。
 * 响应正文读取失败不影响结果，正文退化为空串。
 *
 * @param baseUrl 形如 `http://127.0.0.1:8080`，通常由 {@link baseUrlOf} 生成
 * @param timeoutMs 请求超时毫秒数，默认 2000
 * @returns 健康状态；200 → `ready`，503 → `loading`，其它状态码 → `error`，请求失败 → `unreachable`
 */
export async function fetchHealth(baseUrl: string, timeoutMs = 2000): Promise<HealthResult> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text().catch(() => "");
    if (res.status === 200) return { state: "ready", httpStatus: res.status, body };
    // 503 = router 模式还没加载模型，不是故障
    if (res.status === 503) return { state: "loading", httpStatus: res.status, body };
    return { state: "error", httpStatus: res.status, body, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { state: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** {@link waitForTcp} 的入参 */
export interface WaitOptions {
  host: string;
  port: number;
  /** 总超时毫秒数，默认 90_000（与旧脚本等浏览器打开的窗口一致） */
  timeoutMs?: number;
  /** 两次探测之间的间隔毫秒数，默认 500 */
  intervalMs?: number;
  /** 进程是否已经退出 —— 退出了就别再干等，直接返回，避免白等满超时 */
  hasExited?: () => boolean;
  /** 每次探测失败后的回调，可用来刷新界面上的等待时长 */
  onTick?: (waitedMs: number) => void;
}

/** {@link waitForTcp} 的返回值 */
export interface WaitResult {
  /** 端口是否已开始监听 */
  ok: boolean;
  /** 实际等待了多久（毫秒），成功与失败都会给出 */
  waitedMs: number;
  /** 失败原因：`timeout` = 等满超时，`exited` = 进程先退出了 */
  reason?: "timeout" | "exited";
}

/**
 * 轮询 TCP，直到端口开始监听、进程退出或超时。
 *
 * 判定顺序（重要）：**每轮先看进程是否已退出**，再看端口。
 * 这样进程一起手就崩的情况能立刻返回 `{ ok: false, reason: "exited" }`，
 * 不会让界面白等 90 秒。单次探测的超时取 `min(intervalMs, 800)`，
 * 避免探测本身比轮询间隔还久导致节奏失控。
 *
 * 本函数**永不抛异常**，失败通过返回值表达。
 *
 * @param options 目标地址、端口、超时与回调，见 {@link WaitOptions}
 * @returns 是否就绪、等待时长、失败原因，见 {@link WaitResult}
 */
export async function waitForTcp(options: WaitOptions): Promise<WaitResult> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 500;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (options.hasExited && options.hasExited()) {
      return { ok: false, waitedMs: Date.now() - started, reason: "exited" };
    }
    if (await probeTcp(options.host, options.port, Math.min(intervalMs, 800))) {
      return { ok: true, waitedMs: Date.now() - started };
    }
    options.onTick?.(Date.now() - started);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, waitedMs: Date.now() - started, reason: "timeout" };
}

/**
 * 从 `startPort` 起向后找一个没人监听的端口。
 *
 * 边界：只尝试 `attempts` 个连续端口（默认 20）；**全部被占用时原样返回 `startPort`**
 * 而不是抛错 —— 调用方随后启动服务会失败，但那时能从 llama-server 的
 * "couldn't bind" 日志里拿到更准确的报错并给出诊断。
 *
 * 注意：判断方式仍是 TCP 探测，存在极小的 TOCTOU 窗口（探测到启动之间被别人抢走），
 * 因此这是"尽力而为"的顺延，不是端口预留。
 *
 * @param host 监听地址，通常传 `127.0.0.1`
 * @param startPort 起始端口
 * @param attempts 最多向后试多少个端口，默认 20
 * @returns 找到的空闲端口；都没找到则返回 `startPort`
 */
export async function findFreePort(host: string, startPort: number, attempts = 20): Promise<number> {
  for (let i = 0; i < attempts; i += 1) {
    const port = startPort + i;
    // probeTcp 为 false 说明没人监听 → 可用
    // eslint-disable-next-line no-await-in-loop
    if (!(await probeTcp(host, port, 300))) return port;
  }
  return startPort;
}
