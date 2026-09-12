import assert from "node:assert/strict";
import { test } from "node:test";
import { cpuUsagePct, sampleMemory, snapshotCpuTimes } from "../core/sysinfo.ts";
import type { CpuTimesSnapshot } from "../core/sysinfo.ts";

/** 造一个 os.cpus() 形状的假数据（只填被用到的字段） */
function fakeCores(idle: number, busy: number, count = 1): { model: string; speed: number; times: { user: number; nice: number; sys: number; idle: number; irq: number } }[] {
  return Array.from({ length: count }, () => ({
    model: "Fake CPU",
    speed: 3000,
    times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
  }));
}

test("snapshotCpuTimes 把各核的时间片累加", () => {
  const snap = snapshotCpuTimes(fakeCores(100, 100, 4));
  assert.equal(snap.idle, 400);
  assert.equal(snap.total, 800);
});

test("cpuUsagePct：两次快照算区间平均占用率", () => {
  const prev: CpuTimesSnapshot = { idle: 850, total: 1000 };
  const curr: CpuTimesSnapshot = { idle: 900, total: 1200 }; // 200ms 里 50ms 空闲 → 75% 忙
  assert.equal(cpuUsagePct(prev, curr), 75);
});

test("cpuUsagePct：首次采样返回 null（不能谎报 0%）", () => {
  assert.equal(cpuUsagePct(null, { idle: 100, total: 200 }), null);
});

test("cpuUsagePct：时间片没增长时返回 null（间隔太短/系统挂起）", () => {
  const same: CpuTimesSnapshot = { idle: 500, total: 500 };
  assert.equal(cpuUsagePct(same, { idle: 500, total: 500 }), null);
  // 计数器回绕也不能算出负数
  assert.equal(cpuUsagePct({ idle: 900, total: 1000 }, { idle: 100, total: 200 }), null);
});

test("cpuUsagePct：全空闲与全忙", () => {
  assert.equal(cpuUsagePct({ idle: 0, total: 0 }, { idle: 100, total: 100 }), 0);
  assert.equal(cpuUsagePct({ idle: 0, total: 0 }, { idle: 0, total: 100 }), 100);
});

test("sampleMemory 换算成 MiB 并算比例", () => {
  const stat = sampleMemory(16 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024);
  assert.equal(stat.totalMiB, 16384);
  assert.equal(stat.freeMiB, 4096);
  assert.equal(stat.usedMiB, 12288);
  assert.equal(stat.usedPct, 75);
});

test("sampleMemory：总量为 0 时不除零", () => {
  const stat = sampleMemory(0, 0);
  assert.equal(stat.totalMiB, 0);
  assert.equal(stat.usedMiB, 0);
  assert.equal(stat.usedPct, 0);
});

test("sampleMemory：空闲大于总量时已用不会变负数", () => {
  const stat = sampleMemory(1024 * 1024 * 100, 1024 * 1024 * 200);
  assert.equal(stat.usedMiB, 0);
});
