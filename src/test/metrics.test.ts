import assert from "node:assert/strict";
import { test } from "node:test";
import type { GpuStat } from "../core/gpu.ts";
import { MetricsSampler, toSeries } from "../core/metrics.ts";
import type { MetricsSample } from "../core/metrics.ts";

/** 造一张假显卡的采样值 */
function fakeGpu(usedMiB: number, utilPct: number): GpuStat {
  return {
    index: 0,
    name: "Fake GPU",
    vramTotalMiB: 16380,
    vramUsedMiB: usedMiB,
    vramFreeMiB: 16380 - usedMiB,
    utilizationPct: utilPct,
    memoryUtilizationPct: 0,
    temperatureC: 50,
    powerDrawW: 100,
    powerLimitW: 165,
    clockSmMHz: 2000,
    clockMemMHz: 9000,
  };
}

/** 造一个采样样本 */
function fakeSample(at: number, usedMiB: number, utilPct: number): MetricsSample {
  return {
    at,
    gpus: [fakeGpu(usedMiB, utilPct)],
    gpu: fakeGpu(usedMiB, utilPct),
    cpu: { model: "Fake CPU", cores: 8, usagePct: 25, loadAvg1: null },
    memory: { totalMiB: 32768, usedMiB: 16384, freeMiB: 16384, usedPct: 50 },
    throughput: { at, evalTokPerSec: 42.5 },
    serverState: "running",
  };
}

test("toSeries 逐列映射，缺测值保留 null 而不是 0", () => {
  const noGpu: MetricsSample = { ...fakeSample(3000, 100, 10), gpus: [], gpu: null, cpu: null, memory: null, throughput: null };
  const series = toSeries([fakeSample(1000, 5000, 80), noGpu]);

  assert.deepEqual(series.at, [1000, 3000]);
  assert.deepEqual(series.vramUsedMiB, [5000, null]);
  assert.deepEqual(series.vramTotalMiB, [16380, null]);
  assert.deepEqual(series.gpuUtilPct, [80, null]);
  assert.deepEqual(series.temperatureC, [50, null]);
  assert.deepEqual(series.cpuPct, [25, null]);
  assert.deepEqual(series.memUsedMiB, [16384, null]);
  assert.deepEqual(series.evalTokPerSec, [42.5, null]);
  assert.deepEqual(series.promptTokPerSec, [null, null]);
  // 所有序列等长，绘图时可以直接按下标对齐
  for (const key of Object.keys(series) as (keyof typeof series)[]) {
    assert.equal(series[key].length, 2, `${key} 长度不一致`);
  }
});

test("采样器：注入采集实现后能拿到样本，并按注入值填充字段", async () => {
  let counter = 0;
  const sampler = new MetricsSampler({
    collectGpus: async () => {
      counter += 1;
      return { ok: true, gpus: [fakeGpu(1000 * counter, counter)] };
    },
  });

  const first = await sampler.sampleOnce();
  assert.equal(first.gpu?.vramUsedMiB, 1000);
  assert.equal(first.gpus.length, 1);
  assert.equal(first.serverState, "idle");
  assert.equal(sampler.gpuError(), null);
  // 内存与 CPU 一定采得到（不依赖显卡）
  assert.ok(first.memory !== null);
  assert.ok(first.cpu !== null);
  assert.equal(first.cpu?.cores > 0, true);
});

test("采样器：首次采样的 CPU 占用率为 null（没有上一次快照可比）", async () => {
  const sampler = new MetricsSampler({ collectGpus: async () => ({ ok: true, gpus: [fakeGpu(1, 1)] }) });
  const sample = await sampler.sampleOnce();
  assert.equal(sample.cpu?.usagePct, null);
});

test("采样器：历史受上限约束，保留最近的 N 条", async () => {
  let counter = 0;
  const sampler = new MetricsSampler({
    historyLimit: 3,
    collectGpus: async () => {
      counter += 1;
      return { ok: true, gpus: [fakeGpu(counter, counter)] };
    },
  });

  for (let i = 0; i < 5; i += 1) await sampler.sampleOnce();

  const history = sampler.history();
  assert.equal(history.length, 3, "超过上限应裁掉最旧的");
  assert.deepEqual(history.map((s) => s.gpu?.vramUsedMiB), [3, 4, 5]);
  assert.equal(sampler.latest()?.gpu?.vramUsedMiB, 5);
  assert.equal(sampler.series().vramUsedMiB.length, 3);
});

test("采样器：history 返回副本，外部改动不会污染内部缓冲", async () => {
  const sampler = new MetricsSampler({ collectGpus: async () => ({ ok: true, gpus: [fakeGpu(1, 1)] }) });
  await sampler.sampleOnce();
  const history = sampler.history();
  history.length = 0;
  assert.equal(sampler.history().length, 1);
});

test("采样器：日志里的吞吐会被记进后续样本（用于画 tok/s 曲线）", async () => {
  const sampler = new MetricsSampler({ collectGpus: async () => ({ ok: true, gpus: [fakeGpu(1, 1)] }) });
  sampler.noteThroughput({ evalTokPerSec: 55.5 });
  const sample = await sampler.sampleOnce();
  assert.equal(sample.throughput?.evalTokPerSec, 55.5);

  // 不含吞吐的日志不该把上次的值冲掉
  sampler.noteThroughput({ nCtx: 16384 });
  const again = await sampler.sampleOnce();
  assert.equal(again.throughput?.evalTokPerSec, 55.5);
});

test("采样器：没有 GPU 时 gpu 为 null，且记下原因（界面据此区分「没显卡」与 0%）", async () => {
  const sampler = new MetricsSampler({
    collectGpus: async () => ({ ok: false, gpus: [], error: "nvidia-smi 不存在" }),
  });
  const sample = await sampler.sampleOnce();
  assert.equal(sample.gpu, null);
  assert.deepEqual(sample.gpus, []);
  assert.equal(sampler.gpuError(), "nvidia-smi 不存在");
  // CPU/内存照常采集，不能因为没显卡就整块黑掉
  assert.ok(sample.memory !== null);
});

test("采样器：serverState 随会话更新", async () => {
  const sampler = new MetricsSampler({ collectGpus: async () => ({ ok: true, gpus: [fakeGpu(1, 1)] }) });
  sampler.setServerState("running");
  assert.equal((await sampler.sampleOnce()).serverState, "running");
});

test("采样器：start 幂等，stop 后可再次 start", async () => {
  const sampler = new MetricsSampler({
    intervalMs: 100_000,
    collectGpus: async () => ({ ok: true, gpus: [fakeGpu(1, 1)] }),
  });

  assert.equal(sampler.isRunning(), false);
  sampler.start();
  sampler.start(); // 重复调用不应起两个定时器
  assert.equal(sampler.isRunning(), true);
  sampler.stop();
  assert.equal(sampler.isRunning(), false);
  sampler.stop(); // 幂等
  sampler.start();
  assert.equal(sampler.isRunning(), true);
  sampler.stop();
});

test("采样器：clear 清空历史但保留最近吞吐", async () => {
  const sampler = new MetricsSampler({ collectGpus: async () => ({ ok: true, gpus: [fakeGpu(1, 1)] }) });
  sampler.noteThroughput({ evalTokPerSec: 10 });
  await sampler.sampleOnce();
  sampler.clear();
  assert.deepEqual(sampler.history(), []);
  assert.equal(sampler.latest(), null);
  assert.equal((await sampler.sampleOnce()).throughput?.evalTokPerSec, 10);
});
