/**
 * 指标采样器：定时采集 GPU / CPU / 内存，并把历史存成环形缓冲供界面画曲线。
 *
 * 设计取舍：
 * - **按需采样**：只有界面打开「监控」页时才跑（`start` / `stop`）。
 *   每秒起一个 nvidia-smi 进程是实打实的开销，没人看的时候不该烧。
 *   停止时不清历史，切回来还能看到之前的曲线。
 * - **不重入**：上一轮采样还没回来就跳过这一轮（nvidia-smi 偶发卡顿不会堆积进程）。
 * - **可注入采集函数**：单测里不需要真的装显卡。
 */

import { cpuIdentity, cpuUsagePct, loadAvg1, sampleMemory, snapshotCpuTimes } from "./sysinfo.ts";
import type { CpuStat, CpuTimesSnapshot, MemoryStat } from "./sysinfo.ts";
import { queryGpus } from "./gpu.ts";
import type { GpuStat } from "./gpu.ts";
import type { LogMetrics } from "./logLines.ts";

/** 最近一次从日志里看到的吞吐（用来画 tok/s 曲线） */
export interface ThroughputPoint {
  /** 该数值出现的时间戳（毫秒） */
  at: number;
  /** prompt 处理速度（tok/s） */
  promptEvalTokPerSec?: number;
  /** 生成速度（tok/s） */
  evalTokPerSec?: number;
}

/** 一次完整采样：某一时刻的整机状态快照 */
export interface MetricsSample {
  /** 采样时间戳（毫秒） */
  at: number;
  /** 全部 GPU；没有 NVIDIA 卡时为空数组 */
  gpus: GpuStat[];
  /** 主卡（{@link MetricsSamplerOptions.mainGpuIndex} 指定的那张）；无 GPU 时为 `null` */
  gpu: GpuStat | null;
  cpu: CpuStat | null;
  memory: MemoryStat | null;
  /** 最近一次吞吐；还没发过请求时为 `null` */
  throughput: ThroughputPoint | null;
  /** 采样时 llama-server 的状态（`idle` / `running` / …） */
  serverState: string;
}

/**
 * 把采样序列摊成"一列一个指标"，渲染层可以直接丢给绘图函数。
 *
 * 所有序列等长且与 `at` 一一对应；缺测值保留为 `null`（而不是 0）——
 * 画曲线时要能区分"当时是 0"和"当时测不到"。
 */
export interface MetricsSeries {
  at: number[];
  /** 主卡已用显存（MiB） */
  vramUsedMiB: (number | null)[];
  /** 主卡显存总量（MiB），画进度条上限用 */
  vramTotalMiB: (number | null)[];
  gpuUtilPct: (number | null)[];
  temperatureC: (number | null)[];
  powerW: (number | null)[];
  cpuPct: (number | null)[];
  memUsedMiB: (number | null)[];
  evalTokPerSec: (number | null)[];
  promptTokPerSec: (number | null)[];
}

/**
 * 把采样序列转成按指标分列的序列。
 *
 * @param samples 采样历史（按时间升序）
 * @returns 各指标序列，长度与输入一致
 */
export function toSeries(samples: readonly MetricsSample[]): MetricsSeries {
  const series: MetricsSeries = {
    at: [],
    vramUsedMiB: [],
    vramTotalMiB: [],
    gpuUtilPct: [],
    temperatureC: [],
    powerW: [],
    cpuPct: [],
    memUsedMiB: [],
    evalTokPerSec: [],
    promptTokPerSec: [],
  };

  for (const sample of samples) {
    series.at.push(sample.at);
    series.vramUsedMiB.push(sample.gpu?.vramUsedMiB ?? null);
    series.vramTotalMiB.push(sample.gpu?.vramTotalMiB ?? null);
    series.gpuUtilPct.push(sample.gpu?.utilizationPct ?? null);
    series.temperatureC.push(sample.gpu?.temperatureC ?? null);
    series.powerW.push(sample.gpu?.powerDrawW ?? null);
    series.cpuPct.push(sample.cpu?.usagePct ?? null);
    series.memUsedMiB.push(sample.memory?.usedMiB ?? null);
    series.evalTokPerSec.push(sample.throughput?.evalTokPerSec ?? null);
    series.promptTokPerSec.push(sample.throughput?.promptEvalTokPerSec ?? null);
  }

  return series;
}

/** {@link MetricsSampler} 的构造参数 */
export interface MetricsSamplerOptions {
  /** 采样间隔毫秒数，默认 1000（实测 300ms 会明显吃 CPU） */
  intervalMs?: number;
  /** 历史条数上限，默认 300（1 秒一次 ≈ 5 分钟） */
  historyLimit?: number;
  /** 主卡序号，对应配置里的 `main_gpu`，默认 0 */
  mainGpuIndex?: number;
  /** 每次采样完成后的回调（主进程用它推送给界面） */
  onSample?: (sample: MetricsSample) => void;
  /** 注入自定义的 GPU 采集实现（单测用；默认走 nvidia-smi） */
  collectGpus?: () => Promise<{ ok: boolean; gpus: GpuStat[]; error?: string }>;
}

/**
 * 指标采样器。
 *
 * 生命周期：`start()` 起定时器 → 每 `intervalMs` 采一次 → `stop()` 停表（历史保留）。
 * 采样失败不会中断循环：GPU 拿不到就记 `lastGpuError`，界面据此显示"无 NVIDIA 显卡"。
 */
export class MetricsSampler {
  private readonly intervalMs: number;
  private readonly historyLimit: number;
  private readonly mainGpuIndex: number;
  private readonly onSample: ((sample: MetricsSample) => void) | undefined;
  private readonly collectGpus: () => Promise<{ ok: boolean; gpus: GpuStat[]; error?: string }>;

  /** CPU 型号与核心数不变，采样时只取一次 */
  private readonly identity = cpuIdentity();
  private previousCpu: CpuTimesSnapshot | null = null;
  private ring: MetricsSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 上一轮采样是否还在进行中（避免进程堆积） */
  private sampling = false;
  private throughput: ThroughputPoint | null = null;
  private serverState = "idle";
  private lastGpuError: string | null = null;

  /**
   * @param options 采样间隔、历史上限、主卡序号、回调与可注入的采集实现，见 {@link MetricsSamplerOptions}
   */
  constructor(options: MetricsSamplerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 1000;
    this.historyLimit = options.historyLimit ?? 300;
    this.mainGpuIndex = options.mainGpuIndex ?? 0;
    this.onSample = options.onSample;
    this.collectGpus = options.collectGpus ?? (() => queryGpus());
  }

  /** 采样器是否在跑 */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /** 最近一次 GPU 采集的失败原因；成功时为 `null`（界面据此区分"没显卡"与"0%"） */
  gpuError(): string | null {
    return this.lastGpuError;
  }

  /**
   * 启动定时采样。重复调用是幂等的（已经在跑就什么都不做）。
   *
   * 启动后**立刻采一次**，避免界面打开监控页后先空着 1 秒。
   */
  start(): void {
    if (this.timer !== null) return;
    void this.sampleOnce();
    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, this.intervalMs);
  }

  /** 停止定时采样；历史与最近一次的吞吐保留，切回监控页还能看到之前的曲线 */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 采样一次并放进历史缓冲。
   *
   * 重入保护：若上一轮还没结束则直接返回最近一次结果（nvidia-smi 卡住时不会堆积进程）。
   * **永不抛异常**：GPU 采集失败只记录原因，CPU/内存照常采。
   *
   * @returns 本次（或最近一次）采样
   */
  async sampleOnce(): Promise<MetricsSample> {
    if (this.sampling) return this.latest() ?? this.emptySample();
    this.sampling = true;
    try {
      const snapshot = snapshotCpuTimes();
      const usagePct = cpuUsagePct(this.previousCpu, snapshot);
      this.previousCpu = snapshot;

      const gpuResult = await this.collectGpus();
      this.lastGpuError = gpuResult.ok ? null : (gpuResult.error ?? "GPU 采集失败");
      const gpus = gpuResult.gpus;

      const sample: MetricsSample = {
        at: Date.now(),
        gpus,
        gpu: gpus[this.mainGpuIndex] ?? gpus[0] ?? null,
        cpu: {
          model: this.identity.model,
          cores: this.identity.cores,
          usagePct,
          loadAvg1: loadAvg1(),
        },
        memory: sampleMemory(),
        throughput: this.throughput,
        serverState: this.serverState,
      };

      this.ring.push(sample);
      if (this.ring.length > this.historyLimit) {
        this.ring.splice(0, this.ring.length - this.historyLimit);
      }
      this.onSample?.(sample);
      return sample;
    } finally {
      this.sampling = false;
    }
  }

  /** 记下最近一次从日志里看到的吞吐（由会话在收到含 tok/s 的日志行时调用） */
  noteThroughput(metrics: LogMetrics): void {
    if (metrics.evalTokPerSec === undefined && metrics.promptEvalTokPerSec === undefined) return;
    this.throughput = {
      at: Date.now(),
      promptEvalTokPerSec: metrics.promptEvalTokPerSec,
      evalTokPerSec: metrics.evalTokPerSec,
    };
  }

  /** 更新随采样一起记录的服务状态（让曲线能对齐"什么时候在跑"） */
  setServerState(state: string): void {
    this.serverState = state;
  }

  /** 最近一次采样；还没采过时为 `null` */
  latest(): MetricsSample | null {
    return this.ring[this.ring.length - 1] ?? null;
  }

  /** 全部采样历史（副本，调用方改动不影响内部） */
  history(): MetricsSample[] {
    return [...this.ring];
  }

  /** 历史序列的"按指标分列"版本，供界面直接画图 */
  series(): MetricsSeries {
    return toSeries(this.ring);
  }

  /** 清空历史（换机器/重置展示时用） */
  clear(): void {
    this.ring = [];
  }

  /** 还没采过样时的占位对象，保证调用方拿到的结构一致 */
  private emptySample(): MetricsSample {
    return {
      at: Date.now(),
      gpus: [],
      gpu: null,
      cpu: null,
      memory: null,
      throughput: this.throughput,
      serverState: this.serverState,
    };
  }
}
