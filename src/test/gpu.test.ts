import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildNvidiaSmiQueryArgs,
  GPU_QUERY_FIELDS,
  parseNvidiaSmiCsv,
  parseOptionalNumber,
  vramUsageRatio,
} from "../core/gpu.ts";
import { formatPct, usageBarColor } from "../core/format.ts";

const fixture = readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "nvidia-smi-query.txt"), "utf8");

test("查询参数与字段顺序一致（解析是按位置取值的，错位就全错）", () => {
  const args = buildNvidiaSmiQueryArgs();
  assert.equal(args.length, 2);
  assert.equal(args[0], `--query-gpu=${GPU_QUERY_FIELDS.join(",")}`);
  assert.equal(args[1], "--format=csv,noheader,nounits");
  // 名字必须是第一个字段，解析代码依赖这一点
  assert.equal(GPU_QUERY_FIELDS[0], "name");
});

test("解析真实 nvidia-smi 输出（本机 RTX 4060 Ti 采集的夹具）", () => {
  const gpus = parseNvidiaSmiCsv(fixture);
  assert.equal(gpus.length, 1, "本机只有一张卡");

  const gpu = gpus[0];
  assert.ok(gpu);
  assert.equal(gpu.index, 0);
  assert.equal(gpu.name, "NVIDIA GeForce RTX 4060 Ti");
  assert.equal(gpu.vramTotalMiB, 16380);
  assert.equal(gpu.vramFreeMiB, 15103);
  assert.equal(gpu.utilizationPct, 4);
  assert.equal(gpu.memoryUtilizationPct, 0);
  assert.equal(gpu.temperatureC, 44);
  assert.equal(gpu.powerDrawW, 28.97);
  assert.equal(gpu.powerLimitW, 165);
  assert.equal(gpu.clockSmMHz, 2670);
  assert.equal(gpu.clockMemMHz, 9000);
  // used = total - free（夹具里 1007）
  assert.equal(gpu.vramUsedMiB, 1007);
});

test("解析带 BOM 的输出（工具的锅不该让解析全废）", () => {
  const gpus = parseNvidiaSmiCsv(`\ufeff${fixture}`);
  assert.equal(gpus[0]?.name, "NVIDIA GeForce RTX 4060 Ti");
  assert.equal(gpus[0]?.vramTotalMiB, 16380);
});

test("多卡：一行一张卡，index 按顺序递增", () => {
  const stdout = [
    "NVIDIA GeForce RTX 4090, 24564, 12000, 12564, 80, 40, 65, 300.5, 450.0, 2520, 10501",
    "NVIDIA GeForce RTX 3060, 12288, 500, 11788, 5, 2, 40, 25.0, 170.0, 1800, 7000",
  ].join("\n");
  const gpus = parseNvidiaSmiCsv(stdout);
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0]?.index, 0);
  assert.equal(gpus[1]?.index, 1);
  assert.equal(gpus[1]?.name, "NVIDIA GeForce RTX 3060");
  assert.equal(gpus[0]?.utilizationPct, 80);
});

test("N/A 字段返回 null 而不是 0（0 与「测不到」是两回事）", () => {
  // 笔记本上 power.draw 常为 N/A；老驱动可能整段缺字段
  const stdout = "NVIDIA GeForce MX150, 2048, N/A, N/A, 10, N/A, 55, [N/A], N/A, 1400, N/A";
  const gpus = parseNvidiaSmiCsv(stdout);
  assert.equal(gpus.length, 1);
  const gpu = gpus[0];
  assert.ok(gpu);
  assert.equal(gpu.vramTotalMiB, 2048);
  assert.equal(gpu.vramUsedMiB, null);
  assert.equal(gpu.memoryUtilizationPct, null);
  assert.equal(gpu.powerDrawW, null);
  assert.equal(gpu.powerLimitW, null);
  assert.equal(gpu.clockMemMHz, null);
  assert.equal(gpu.utilizationPct, 10);
  assert.equal(gpu.temperatureC, 55);
});

test("字段数不足时不抛异常，缺的按 null 处理", () => {
  const gpus = parseNvidiaSmiCsv("NVIDIA GeForce GTX 1050, 4096");
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0]?.vramTotalMiB, 4096);
  assert.equal(gpus[0]?.utilizationPct, null);
  assert.equal(gpus[0]?.clockMemMHz, null);
});

test("空行与噪音行被忽略", () => {
  const stdout = ["", "  ", "NVIDIA GeForce RTX 4060 Ti, 16380, 1007, 15103, 4, 0, 44, 28.97, 165.00, 2670, 9000", ""].join(
    "\n",
  );
  assert.equal(parseNvidiaSmiCsv(stdout).length, 1);
  assert.deepEqual(parseNvidiaSmiCsv(""), []);
});

test("带单位的写法也能解析（去掉表头模式下的输出）", () => {
  const stdout = "NVIDIA GeForce RTX 4060 Ti, 16380 MiB, 1007 MiB, 15103 MiB, 4 %, 0 %, 44, 29.01 W, 165.00 W, 2670 MHz, 9000 MHz";
  const gpu = parseNvidiaSmiCsv(stdout)[0];
  assert.ok(gpu);
  assert.equal(gpu.vramTotalMiB, 16380);
  assert.equal(gpu.utilizationPct, 4);
  assert.equal(gpu.powerDrawW, 29.01);
  assert.equal(gpu.clockSmMHz, 2670);
});

test("parseOptionalNumber 的边界", () => {
  assert.equal(parseOptionalNumber("16380"), 16380);
  assert.equal(parseOptionalNumber("  28.97  "), 28.97);
  assert.equal(parseOptionalNumber("1007 MiB"), 1007);
  assert.equal(parseOptionalNumber("N/A"), null);
  assert.equal(parseOptionalNumber("[N/A]"), null);
  assert.equal(parseOptionalNumber(""), null);
  assert.equal(parseOptionalNumber("   "), null);
  assert.equal(parseOptionalNumber("abc"), null);
});

test("vramUsageRatio：算比例、防除零、夹到 0~1", () => {
  const base = parseNvidiaSmiCsv(fixture)[0];
  assert.ok(base);
  const ratio = vramUsageRatio(base.vramUsedMiB, base.vramTotalMiB);
  assert.ok(ratio !== null && ratio > 0 && ratio < 0.2, `实际 ${String(ratio)}`);

  assert.equal(vramUsageRatio(1, 0), null, "总量为 0 不能除零");
  assert.equal(vramUsageRatio(null, 100), null, "用量未知");
  assert.equal(vramUsageRatio(10, null), null, "总量未知");
  // 异常数据（已用 > 总量）也不能画出超过 100% 的进度条
  assert.equal(vramUsageRatio(99999, 100), 1);
  assert.equal(vramUsageRatio(-5, 100), 0);
});

test("formatPct / usageBarColor：都由 format.ts 提供，且阈值只有一处定义", () => {
  assert.equal(formatPct(42.5), "43%");
  assert.equal(formatPct(42.46, 1), "42.5%");
  assert.equal(formatPct(null), "N/A");
  assert.equal(usageBarColor(null), "bg-slate-600");
  assert.equal(usageBarColor(0.5), "bg-sky-500");
  assert.equal(usageBarColor(0.8), "bg-amber-500");
  assert.equal(usageBarColor(0.95), "bg-rose-500");
});
