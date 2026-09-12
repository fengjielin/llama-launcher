/**
 * GPU 指标采集（NVIDIA，走 `nvidia-smi`）。
 *
 * 为什么用 nvidia-smi 而不是 NVML 绑定：零依赖、跨驱动版本稳定，且它的输出格式
 * 十几年没变过。代价是每次采集要起一个进程，所以采样间隔取 1 秒 ——
 * 实测 300ms 那种频率会把 CPU 占用明显抬起来，得不偿失。
 *
 * 实测（本机 RTX 4060 Ti / 驱动 566.36）加了 `nounits` 之后是纯数字：
 *   `NVIDIA GeForce RTX 4060 Ti, 16380, 1007, 15103, 4, 0, 44, 28.97, 165.00, 2670, 9000`
 * 字段顺序与 {@link GPU_QUERY_FIELDS} 一一对应。
 */

import { runCapture } from "./llamaProcess.ts";

// 格式化与比例换算放在 format.ts（无 Node 依赖），由这里转出以保持既有引用路径不变。
// 渲染层要用这些函数时请直接从 core/format.ts 引用，别经过本文件 ——
// 本文件为了采集而 import 了 node:child_process，会污染浏览器产物。
export { formatMiB, vramUsageRatio } from "./format.ts";

/**
 * `--query-gpu` 的字段顺序。
 *
 * ⚠ 改这里必须同步改 {@link parseNvidiaSmiCsv} 里的取值顺序 —— 解析是按位置取值的，
 * 而 `--query-gpu` 的输出不带表头（`noheader`），位置错一位就会张冠李戴。
 */
export const GPU_QUERY_FIELDS: readonly string[] = [
  "name",
  "memory.total",
  "memory.used",
  "memory.free",
  "utilization.gpu",
  "utilization.memory",
  "temperature.gpu",
  "power.draw",
  "power.limit",
  "clocks.sm",
  "clocks.mem",
];

/** 单张 GPU 的一次采样结果；所有数值字段都可能为 `null`（该卡不支持该字段时为 N/A） */
export interface GpuStat {
  /** 显卡序号，与 `--main-gpu` 的编号一致 */
  index: number;
  /** 显卡型号，如 `NVIDIA GeForce RTX 4060 Ti` */
  name: string;
  /** 显存总量（MiB） */
  vramTotalMiB: number | null;
  /** 已用显存（MiB） */
  vramUsedMiB: number | null;
  /** 剩余显存（MiB） */
  vramFreeMiB: number | null;
  /** GPU 核心利用率（%） */
  utilizationPct: number | null;
  /** 显存控制器利用率（%） */
  memoryUtilizationPct: number | null;
  /** 核心温度（℃） */
  temperatureC: number | null;
  /** 当前功耗（W） */
  powerDrawW: number | null;
  /** 功耗上限（W） */
  powerLimitW: number | null;
  /** SM 当前频率（MHz） */
  clockSmMHz: number | null;
  /** 显存当前频率（MHz） */
  clockMemMHz: number | null;
}

/** {@link queryGpus} 的返回值 */
export interface GpuQueryResult {
  /** 是否成功拿到数据（false 时 `gpus` 为空、`error` 有说明） */
  ok: boolean;
  gpus: GpuStat[];
  /** 失败原因，如"没装 nvidia-smi"（非 NVIDIA 机器的正常情况） */
  error?: string;
}

/**
 * 拼出 `nvidia-smi` 的查询参数。
 *
 * @returns 形如 `["--query-gpu=name,memory.total,...", "--format=csv,noheader,nounits"]`
 */
export function buildNvidiaSmiQueryArgs(): string[] {
  return [`--query-gpu=${GPU_QUERY_FIELDS.join(",")}`, "--format=csv,noheader,nounits"];
}

/**
 * 解析一个可能为空的数值字段。
 *
 * 需要容错的情况（都实测或已知会出现）：
 * - `N/A` / `[N/A]`：该字段在这张卡上不可用（如笔记本的 `power.draw`）
 * - 带单位的写法（`1007 MiB` / `29.01 W` / `4 %`）：去掉表头模式与 `nounits` 模式下都可能碰到
 * - 空串
 *
 * @param raw 原始字段文本
 * @returns 解析出的数字；无法解析时返回 `null`（**不要返回 0**，0 与"不可用"是两回事）
 */
export function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || /^\[?N\/A\]?$/i.test(trimmed)) return null;
  const cleaned = trimmed.replace(/[^\d.+-]/g, "");
  if (cleaned === "") return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * 解析 `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` 的输出。
 *
 * 按**位置**取值（顺序见 {@link GPU_QUERY_FIELDS}）。边界处理：
 * - 一张卡一行，多卡就是多行；空行跳过
 * - 显卡名理论上不含逗号，但真出现时按 `字段数 - 10` 兜底拼回名字，
 *   以免后面所有数值整体错位（错位比解析失败更难发现）
 * - 字段数不足（老驱动不支持某些字段）时，缺的按 `null` 处理，不抛异常
 *
 * @param stdout nvidia-smi 的标准输出（`--version` 之类的噪音行会被忽略）
 * @returns 每张卡一条记录；没有任何可用行时返回空数组
 */
export function parseNvidiaSmiCsv(stdout: string): GpuStat[] {
  const numericFieldCount = GPU_QUERY_FIELDS.length - 1;
  const gpus: GpuStat[] = [];

  // 容错：输出若是被带 BOM 的工具写进文件的，首个字段（显卡名）会带上 \ufeff
  const text = stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const fields = trimmed.split(",").map((f) => f.trim());

    // 至少要能容下"名字 + 若干数值"；不足则说明这一行不是查询结果
    if (fields.length < 2) continue;

    const nameCount = Math.max(1, fields.length - numericFieldCount);
    const name = fields.slice(0, nameCount).join(", ");
    const nums = fields.slice(nameCount);

    gpus.push({
      index: gpus.length,
      name,
      vramTotalMiB: parseOptionalNumber(nums[0] ?? ""),
      vramUsedMiB: parseOptionalNumber(nums[1] ?? ""),
      vramFreeMiB: parseOptionalNumber(nums[2] ?? ""),
      utilizationPct: parseOptionalNumber(nums[3] ?? ""),
      memoryUtilizationPct: parseOptionalNumber(nums[4] ?? ""),
      temperatureC: parseOptionalNumber(nums[5] ?? ""),
      powerDrawW: parseOptionalNumber(nums[6] ?? ""),
      powerLimitW: parseOptionalNumber(nums[7] ?? ""),
      clockSmMHz: parseOptionalNumber(nums[8] ?? ""),
      clockMemMHz: parseOptionalNumber(nums[9] ?? ""),
    });
  }

  return gpus;
}

/**
 * 现场查一次所有 GPU 的状态。
 *
 * **永不抛异常**：没装 nvidia-smi、非 NVIDIA 机器、驱动异常等情况统一走
 * `{ ok: false, error }` —— 这是"没有 GPU 也能用启动器"的前提（纯 CPU 推理同样支持）。
 *
 * @param timeoutMs 命令超时毫秒数，默认 4000；采样循环里别设太大，否则会拖慢节奏
 * @returns 采集结果，见 {@link GpuQueryResult}
 */
export async function queryGpus(timeoutMs = 4000): Promise<GpuQueryResult> {
  const result = await runCapture("nvidia-smi", buildNvidiaSmiQueryArgs(), timeoutMs);
  if (result.error !== undefined) return { ok: false, gpus: [], error: result.error };

  const gpus = parseNvidiaSmiCsv(result.stdout);
  if (gpus.length === 0) {
    return {
      ok: false,
      gpus: [],
      error: result.code === 0 ? "nvidia-smi 没有返回任何显卡信息" : `nvidia-smi 退出码 ${String(result.code)}`,
    };
  }
  return { ok: true, gpus };
}
