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

export type HealthState = "ready" | "loading" | "error" | "unreachable";

export interface HealthResult {
  state: HealthState;
  httpStatus?: number;
  body?: string;
  detail?: string;
}

/** TCP 连通性探测（最可靠的"端口已监听"信号） */
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

export function baseUrlOf(host: string, port: number): string {
  // 0.0.0.0 是"监听所有网卡"，本机访问要走 127.0.0.1
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${h}:${port}`;
}

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

export interface WaitOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  intervalMs?: number;
  /** 进程是否已经退出 —— 退出了就别再干等 */
  hasExited?: () => boolean;
  onTick?: (waitedMs: number) => void;
}

export interface WaitResult {
  ok: boolean;
  waitedMs: number;
  reason?: "timeout" | "exited";
}

/** 轮询 TCP，直到端口开始监听（或进程退出 / 超时） */
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

/** 端口占用检测：占用则从 startPort 往后顺延（与 PS1 的"被占用会自动顺延"一致） */
export async function findFreePort(host: string, startPort: number, attempts = 20): Promise<number> {
  for (let i = 0; i < attempts; i += 1) {
    const port = startPort + i;
    // probeTcp 为 false 说明没人监听 → 可用
    // eslint-disable-next-line no-await-in-loop
    if (!(await probeTcp(host, port, 300))) return port;
  }
  return startPort;
}
