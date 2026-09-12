/**
 * CPU / 内存采样（Node 内置 `os`，零依赖）。
 *
 * 为什么 CPU 占用率不能直接读一个数：`os.cpus()` 给的是各核的**累计**时间片。
 * 想得到"这一秒的占用率"，必须保存上一次快照做差分 —— 这也是
 * {@link snapshotCpuTimes} 与 {@link cpuUsagePct} 拆开的原因：
 * 采样器负责"记住上一次"，纯函数负责"算差分"。
 */

import { cpus, freemem, loadavg, totalmem } from "node:os";

/** CPU 时间片快照，用于两次采样之间做差分 */
export interface CpuTimesSnapshot {
  /** 各核空闲时间片之和（毫秒） */
  idle: number;
  /** 各核时间片总和（毫秒） */
  total: number;
}

/** 一次 CPU 采样结果 */
export interface CpuStat {
  /** CPU 型号，如 `13th Gen Intel(R) Core(TM) i5-13600K` */
  model: string;
  /** 逻辑核心数 */
  cores: number;
  /** 两次采样之间的平均占用率（%）；首次采样（没有上一次）时为 `null` */
  usagePct: number | null;
  /** 系统 1 分钟平均负载（Windows 上恒为 0，仅类 Unix 有意义） */
  loadAvg1: number | null;
}

/** 一次内存采样结果（单位统一用 MiB，方便与显存对比展示） */
export interface MemoryStat {
  /** 物理内存总量（MiB） */
  totalMiB: number;
  /** 已用（MiB） */
  usedMiB: number;
  /** 空闲（MiB） */
  freeMiB: number;
  /** 已用比例（%），0~100 */
  usedPct: number;
}

const BYTES_PER_MIB = 1024 * 1024;

/**
 * 取一次 CPU 时间片快照（各核累加）。
 *
 * @param cores `os.cpus()` 的返回值；显式传参便于测试注入假数据
 * @returns 空闲与总时间片；拿不到任何核时都为 0
 */
export function snapshotCpuTimes(cores: ReturnType<typeof cpus> = cpus()): CpuTimesSnapshot {
  let idle = 0;
  let total = 0;
  for (const core of cores) {
    idle += core.times.idle;
    total += core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq;
  }
  return { idle, total };
}

/**
 * 用两次快照算区间内的 CPU 平均占用率。
 *
 * 边界：任一快照缺失、或总时间片没有增长（间隔太短/系统挂起）时返回 `null` ——
 * 返回 0 会被误读成"CPU 完全空闲"，而实际情况是"测不出来"。
 *
 * @param previous 上一次快照；首次采样传 `null`
 * @param current 本次快照
 * @returns 占用率百分比（0~100，保留 1 位）；无法计算时返回 `null`
 */
export function cpuUsagePct(previous: CpuTimesSnapshot | null, current: CpuTimesSnapshot): number | null {
  if (previous === null) return null;
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0) return null;
  const usage = (1 - idleDelta / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, usage)) * 10) / 10;
}

/**
 * 采样一次内存使用情况。
 *
 * @param totalBytes 总内存字节数，默认取 `os.totalmem()`
 * @param freeBytes 空闲内存字节数，默认取 `os.freemem()`
 * @returns 以 MiB 为单位的内存状态；总量为 0 时比例记为 0（不除零）
 */
export function sampleMemory(totalBytes: number = totalmem(), freeBytes: number = freemem()): MemoryStat {
  const totalMiB = Math.round(totalBytes / BYTES_PER_MIB);
  const freeMiB = Math.round(freeBytes / BYTES_PER_MIB);
  const usedMiB = Math.max(0, totalMiB - freeMiB);
  return {
    totalMiB,
    usedMiB,
    freeMiB,
    usedPct: totalMiB === 0 ? 0 : Math.round((usedMiB / totalMiB) * 1000) / 10,
  };
}

/**
 * 取 CPU 型号与核心数（用于展示，能显示的话比只给个百分比有用得多）。
 *
 * @param cores `os.cpus()` 的返回值
 * @returns 型号取首个核心的 `model`；拿不到时返回 `"未知 CPU"`
 */
export function cpuIdentity(cores: ReturnType<typeof cpus> = cpus()): { model: string; cores: number } {
  return { model: cores[0]?.model ?? "未知 CPU", cores: cores.length };
}

/**
 * 取 1 分钟平均负载。
 *
 * @returns 类 Unix 上是有效值；Windows 上恒为 0（系统不提供），此时返回 `null` 而不是 0
 */
export function loadAvg1(): number | null {
  const values = loadavg();
  const first = values[0];
  if (first === undefined || first === 0) return null;
  return first;
}
