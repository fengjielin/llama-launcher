import { useEffect } from "react";
import type { ReactNode } from "react";
import { formatMiB, formatPct, usageBarColor, vramUsageRatio } from "../../../core/format.ts";
import type { GpuStat } from "../../../core/gpu.ts";
import type { MetricsPayload } from "../../../shared/ipc.ts";
import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge, Section } from "./ui.tsx";

/**
 * 折线图（手写 SVG，零依赖）。
 *
 * 为什么不用图表库：这里只需要"一条随时间变化的线"，引一个图表库要多几百 KB，
 * 而且仪表盘这种场景用不上它的交互能力。
 *
 * 处理要点：
 * - `null` 是"当时测不到"，不是 0 —— 遇到 null 会**断开线段**，
 *   而不是把两点直接连起来（那会画出一条不存在的斜线）
 * - 只有一个有效点时画不出线，退化为"数据不足"提示
 * - 用 `viewBox` + `preserveAspectRatio="none"` 让折线自适应宽度，
 *   配 `vector-effect: non-scaling-stroke` 保证线宽不被拉伸
 *
 * @param props.values 数值序列（与采样一一对应，可能含 null）
 * @param props.color 线条颜色（CSS 颜色值）
 * @param props.height SVG 视口高度，默认 28
 * @returns SVG 节点
 */
function Sparkline({ values, color, height = 28 }: { values: (number | null)[]; color: string; height?: number }): ReactNode {
  const numbers = values.filter((v): v is number => v !== null);
  if (numbers.length < 2) {
    return <div className="flex h-7 items-center text-[10px] text-slate-600">数据不足</div>;
  }

  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const span = max - min || 1;
  const width = 100;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const y = (value: number): number => height - 2 - ((value - min) / span) * (height - 4);

  // 按 null 切段：每段是连续的有效点
  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${(index * step).toFixed(2)},${y(value).toFixed(2)}`);
  });
  if (current.length > 0) segments.push(current.join(" "));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-7 w-full">
      {segments
        .filter((segment) => segment.includes(" "))
        .map((segment, index) => (
          <polyline
            key={index}
            points={segment}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        ))}
    </svg>
  );
}

/**
 * 一张指标卡：标题 + 当前值 + 折线 + 可选副标题。
 *
 * @param props.title 指标名
 * @param props.value 当前值（已格式化好的字符串）
 * @param props.sub 副标题（如"共 16.0 GB"）
 * @param props.series 折线数据
 * @param props.color 折线颜色
 * @param props.bar 进度条比例（0~1）；`null` 表示不显示
 * @returns 卡片节点
 */
function StatCard({
  title,
  value,
  sub,
  series,
  color,
  bar = null,
}: {
  title: string;
  value: string;
  sub?: string;
  series: (number | null)[];
  color: string;
  bar?: number | null;
}): ReactNode {
  return (
    <div className="rounded-lg border border-[#1e2530] bg-[#11151d] px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-slate-400">{title}</span>
        <span className="mono text-sm font-medium text-slate-100">{value}</span>
      </div>
      {bar === null ? null : (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#1b2230]">
          <div className={`h-full rounded-full ${usageBarColor(bar)}`} style={{ width: `${Math.round(bar * 100)}%` }} />
        </div>
      )}
      <div className="mt-1">
        <Sparkline values={series} color={color} />
      </div>
      {sub === undefined ? null : <p className="mt-0.5 text-[10px] text-slate-500">{sub}</p>}
    </div>
  );
}

/** GPU 型号与静态信息（总量、功耗上限、频率），只在有卡时显示 */
function GpuHeader({ gpu, count }: { gpu: GpuStat; count: number }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone="sky">{gpu.name}</Badge>
      {count > 1 ? <Badge tone="slate">检测到 {count} 张卡，这里显示主卡</Badge> : null}
      <span className="text-[11px] text-slate-500">
        显存 {formatMiB(gpu.vramTotalMiB)}
        {gpu.powerLimitW === null ? "" : ` · 功耗上限 ${gpu.powerLimitW.toFixed(0)} W`}
        {gpu.clockSmMHz === null ? "" : ` · SM ${gpu.clockSmMHz} MHz`}
        {gpu.clockMemMHz === null ? "" : ` · 显存 ${gpu.clockMemMHz} MHz`}
      </span>
    </div>
  );
}

/**
 * 资源监控面板：GPU / CPU / 内存 / 吞吐。
 *
 * 采样生命周期由本组件拥有：挂载时开、卸载时关
 * （每秒起一个 `nvidia-smi` 进程是实打实的开销，没人看的时候不该烧）。
 *
 * @param props.launcher 界面状态控制器；数据来自 `metrics`（含历史序列）
 * @returns 监控面板节点
 */
export function MetricsPanel({ launcher }: { launcher: LauncherController }): ReactNode {
  const { metrics, watchMetrics } = launcher;

  useEffect(() => {
    watchMetrics(true);
    return () => watchMetrics(false);
  }, [watchMetrics]);

  if (metrics === null) {
    return <div className="p-4 text-xs text-slate-500">正在采集…（打开本页会开始每秒采样一次）</div>;
  }

  const latest = metrics.latest;
  const series = metrics.series;
  const gpu = latest?.gpu ?? null;
  const cpu = latest?.cpu ?? null;
  const memory = latest?.memory ?? null;
  const throughput = latest?.throughput ?? null;
  const vramRatio = gpu === null ? null : vramUsageRatio(gpu.vramUsedMiB, gpu.vramTotalMiB);

  return (
    <div className="h-full space-y-3 overflow-y-auto px-4 py-3">
      {metrics.gpuError === null ? null : (
        <div className="rounded-md border border-amber-900/50 bg-amber-950/20 px-3 py-2">
          <div className="flex items-center gap-2">
            <Badge tone="amber">没有可用的 GPU 数据</Badge>
            <span className="text-[11px] text-amber-200/80">{metrics.gpuError}</span>
          </div>
          <p className="mt-1 text-[11px] text-amber-200/70">
            非 NVIDIA 显卡或没装 nvidia-smi 都会这样，不影响 llama.cpp 用纯 CPU 或其它后端跑。
          </p>
        </div>
      )}

      {latest === null ? (
        <p className="text-xs text-slate-500">正在采集第一组数据…</p>
      ) : (
        <>
          <Section title="GPU" right={gpu === null ? <Badge tone="slate">无数据</Badge> : undefined}>
            {gpu === null ? (
              <p className="text-[11px] text-slate-500">当前没有检测到 NVIDIA 显卡。</p>
            ) : (
              <div className="space-y-2.5">
                <GpuHeader gpu={gpu} count={latest.gpus.length} />
                <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
                  <StatCard
                    title="显存占用"
                    value={formatMiB(gpu.vramUsedMiB)}
                    sub={`共 ${formatMiB(gpu.vramTotalMiB)} · 剩余 ${formatMiB(gpu.vramFreeMiB)}`}
                    series={series.vramUsedMiB}
                    color="#38bdf8"
                    bar={vramRatio}
                  />
                  <StatCard
                    title="GPU 利用率"
                    value={formatPct(gpu.utilizationPct)}
                    sub={`显存控制器 ${formatPct(gpu.memoryUtilizationPct)}`}
                    series={series.gpuUtilPct}
                    color="#a78bfa"
                  />
                  <StatCard
                    title="温度"
                    value={gpu.temperatureC === null ? "N/A" : `${gpu.temperatureC} ℃`}
                    series={series.temperatureC}
                    color="#fb7185"
                  />
                  <StatCard
                    title="功耗"
                    value={gpu.powerDrawW === null ? "N/A" : `${gpu.powerDrawW.toFixed(1)} W`}
                    sub={gpu.powerLimitW === null ? undefined : `上限 ${gpu.powerLimitW.toFixed(0)} W`}
                    series={series.powerW}
                    color="#fbbf24"
                  />
                </div>
              </div>
            )}
          </Section>

          <Section title="CPU / 内存">
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              <StatCard
                title="CPU 占用"
                value={formatPct(cpu?.usagePct ?? null)}
                sub={
                  cpu === null
                    ? undefined
                    : `${cpu.cores} 逻辑核心 · ${cpu.model}${cpu.loadAvg1 === null ? "" : ` · load ${cpu.loadAvg1.toFixed(2)}`}`
                }
                series={series.cpuPct}
                color="#34d399"
              />
              <StatCard
                title="内存占用"
                value={memory === null ? "N/A" : formatPct(memory.usedPct)}
                sub={memory === null ? undefined : `已用 ${formatMiB(memory.usedMiB)} / 共 ${formatMiB(memory.totalMiB)}`}
                series={series.memUsedMiB}
                color="#60a5fa"
                bar={memory === null ? null : memory.usedPct / 100}
              />
            </div>
          </Section>

          <Section
            title="推理吞吐"
            right={
              throughput === null ? (
                <Badge tone="slate">还没有请求</Badge>
              ) : (
                <Badge tone="violet">更新于 {new Date(throughput.at).toLocaleTimeString("zh-CN", { hour12: false })}</Badge>
              )
            }
          >
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              <StatCard
                title="生成速度"
                value={
                  throughput?.evalTokPerSec === undefined ? "—" : `${throughput.evalTokPerSec.toFixed(1)} tok/s`
                }
                sub="来自 llama-server 日志里的 eval time 行"
                series={series.evalTokPerSec}
                color="#c084fc"
              />
              <StatCard
                title="prompt 处理速度"
                value={
                  throughput?.promptEvalTokPerSec === undefined
                    ? "—"
                    : `${throughput.promptEvalTokPerSec.toFixed(1)} tok/s`
                }
                sub="长 prompt 的首 token 延迟主要看它"
                series={series.promptTokPerSec}
                color="#f472b6"
              />
            </div>
            <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] md:grid-cols-4">
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">采样点</dt>
                <dd className="mono text-slate-300">{series.at.length}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">采样中</dt>
                <dd className="mono text-slate-300">{metrics.running ? "是" : "否"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">服务状态</dt>
                <dd className="mono text-slate-300">{latest.serverState}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">最近采样</dt>
                <dd className="mono text-slate-300">
                  {new Date(latest.at).toLocaleTimeString("zh-CN", { hour12: false })}
                </dd>
              </div>
            </dl>
          </Section>

          <p className="pb-2 text-[11px] leading-5 text-slate-500">
            采样间隔 1 秒，只在打开本页时进行（切走即停，历史保留）。
            曲线里的断口表示那一刻没测到数据，不是 0。
          </p>
        </>
      )}
    </div>
  );
}
