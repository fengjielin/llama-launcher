/**
 * 纯格式化工具（**无任何 Node 依赖**）。
 *
 * 单独成文件的原因：渲染层也要用这些换算（显存大小、占用比例），
 * 而 `core/gpu.ts` 为了采集会 import `node:child_process` —— 一旦渲染层直接引用它，
 * Vite 打包时就会把 Node 内置模块带进浏览器产物并报错。
 * 放在这个"叶子模块"里，主进程与渲染层都能安全引用。
 */

/** 1 MiB 的字节数 */
const BYTES_PER_MIB = 1024 * 1024;

/**
 * 把 MiB 数值格式化成便于阅读的显存大小。
 *
 * @param mib 显存大小（MiB）；传 `null` 表示该字段不可用
 * @param digits 保留几位小数，默认 1
 * @returns 1024 MiB 及以上显示为 `x.x GB`，否则显示 `xxx MiB`；`null` 返回 `"N/A"`
 */
export function formatMiB(mib: number | null, digits = 1): string {
  if (mib === null) return "N/A";
  if (mib >= 1024) return `${(mib / 1024).toFixed(digits)} GB`;
  return `${Math.round(mib)} MiB`;
}

/**
 * 把字节数换算成 MiB（四舍五入）。
 *
 * @param bytes 字节数
 * @returns MiB 数值
 */
export function bytesToMiB(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MIB);
}

/**
 * 算显存占用比例（0~1），用于画进度条与配色。
 *
 * 边界：用量或总量缺失、总量为 0 时返回 `null`（避免除零与"假的 0%"）；
 * 用量超过总量（驱动口径差异）时夹到 1，不让进度条溢出。
 *
 * @param usedMiB 已用显存（MiB），可为 `null`
 * @param totalMiB 显存总量（MiB），可为 `null`
 * @returns 占用比例；无法计算时返回 `null`
 */
export function vramUsageRatio(usedMiB: number | null, totalMiB: number | null): number | null {
  if (usedMiB === null || totalMiB === null || totalMiB <= 0) return null;
  return Math.min(1, Math.max(0, usedMiB / totalMiB));
}

/**
 * 按占用比例给进度条选颜色：低=蓝，中=琥珀，高=玫红。
 *
 * 放在这里而不是组件里，是为了让"多少算高"只有一个出处。
 *
 * @param ratio 占用比例（0~1）；`null` 表示未知
 * @returns Tailwind 颜色类名
 */
export function usageBarColor(ratio: number | null): string {
  if (ratio === null) return "bg-slate-600";
  if (ratio >= 0.9) return "bg-rose-500";
  if (ratio >= 0.75) return "bg-amber-500";
  return "bg-sky-500";
}

/**
 * 格式化百分比数值。
 *
 * @param value 百分比数值（如 42.5）；`null` 表示测不到
 * @param digits 保留几位小数，默认 0
 * @returns 形如 `43%`；`null` 返回 `"N/A"`
 */
export function formatPct(value: number | null, digits = 0): string {
  if (value === null) return "N/A";
  return `${value.toFixed(digits)}%`;
}
