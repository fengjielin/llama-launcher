import type { ReactNode } from "react";
import { formatMiB } from "../../../core/format.ts";
import type { PrecheckItem, PrecheckLevel } from "../../../core/precheck.ts";
import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge, Button, Section } from "./ui.tsx";
import type { Tone } from "./ui.tsx";

/** 级别 → 展示样式：颜色、符号、以及给用户看的说法 */
const LEVEL_STYLE: Record<PrecheckLevel, { tone: Tone; icon: string; label: string }> = {
  error: { tone: "rose", icon: "✕", label: "会导致启动失败" },
  warn: { tone: "amber", icon: "!", label: "需要注意" },
  info: { tone: "sky", icon: "i", label: "信息" },
  ok: { tone: "emerald", icon: "✓", label: "正常" },
};

/** 展示顺序：越严重的越靠前 */
const LEVEL_ORDER: readonly PrecheckLevel[] = ["error", "warn", "info", "ok"];

/**
 * 一条自检结论。
 *
 * @param props.item 结论（标题、事实、建议）
 * @returns 结论节点
 */
function ItemRow({ item }: { item: PrecheckItem }): ReactNode {
  const style = LEVEL_STYLE[item.level];
  return (
    <div className="flex items-start gap-2.5 border-b border-[#161b24] py-2 last:border-b-0">
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ring-1 ring-inset ${
          style.tone === "rose"
            ? "bg-rose-500/15 text-rose-300 ring-rose-500/40"
            : style.tone === "amber"
              ? "bg-amber-500/15 text-amber-300 ring-amber-500/40"
              : style.tone === "sky"
                ? "bg-sky-500/15 text-sky-300 ring-sky-500/40"
                : "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40"
        }`}
        title={style.label}
      >
        {style.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-slate-200">{item.title}</div>
        <div className="mono mt-0.5 break-all text-[11px] leading-5 text-slate-500">{item.detail}</div>
        {item.suggestion === undefined ? null : (
          <div className="mt-0.5 text-[11px] leading-5 text-sky-300/80">→ {item.suggestion}</div>
        )}
      </div>
    </div>
  );
}

/**
 * 环境自检面板。
 *
 * 回答的是「这份 llama.cpp 构建 + 这台机器」配不配得上，例如：
 * 驱动版本够不够跑这个 CUDA 构建、CUDA 运行时 DLL 在不在、模型装不装得进显存。
 * 判断依据来自 `ggml-cuda.dll` 的导入表与 `nvidia-smi`，不依赖任何网络请求。
 *
 * @param props.launcher 界面状态控制器；报告来自 `precheck`
 * @returns 自检面板节点
 */
export function PrecheckPanel({ launcher }: { launcher: LauncherController }): ReactNode {
  const { precheck, runPrecheckNow, busy } = launcher;

  if (precheck === null) {
    return <div className="p-4 text-xs text-slate-500">正在自检…（会读一次 ggml-cuda.dll 的导入表并查一次显卡）</div>;
  }

  const counts = LEVEL_ORDER.map((level) => ({
    level,
    count: precheck.items.filter((item) => item.level === level).length,
  })).filter((entry) => entry.count > 0);
  const facts = precheck.facts;

  return (
    <div className="h-full space-y-3 overflow-y-auto px-4 py-3">
      <Section
        title="环境自检"
        right={
          <div className="flex items-center gap-2">
            <Badge tone={LEVEL_STYLE[precheck.verdict].tone}>
              {precheck.verdict === "ok" ? "一切正常" : LEVEL_STYLE[precheck.verdict].label}
            </Badge>
            <Button disabled={busy !== null} onClick={() => void runPrecheckNow()}>
              重新自检
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          {counts.map((entry) => (
            <span key={entry.level}>
              <Badge tone={LEVEL_STYLE[entry.level].tone}>
                {LEVEL_STYLE[entry.level].label} {entry.count}
              </Badge>
            </span>
          ))}
          <span className="ml-auto">
            自检于 {new Date(precheck.at).toLocaleTimeString("zh-CN", { hour12: false })} ·
            结果按配置缓存，改了构建目录/模型/端口会自动重跑
          </span>
        </div>

        <div className="mt-2">
          {LEVEL_ORDER.flatMap((level) =>
            precheck.items.filter((item) => item.level === level).map((item) => <ItemRow key={item.id} item={item} />),
          )}
        </div>
      </Section>

      <Section title="采集到的事实">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[11px] md:grid-cols-2">
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">可执行文件</dt>
            <dd className="mono min-w-0 break-all text-slate-300">{facts.exe === "" ? "未找到" : facts.exe}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">检测到的后端</dt>
            <dd className="mono text-slate-300">{facts.backends.join("、") || "（无）"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">构建所需的 CUDA</dt>
            <dd className="mono text-slate-300">
              {facts.cudaRequiredMajor === null ? "不需要（无 CUDA 后端）" : `CUDA ${facts.cudaRequiredMajor}`}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">导入的 CUDA 运行库</dt>
            <dd className="mono min-w-0 break-all text-slate-300">{facts.cudaRuntimeDlls.join("、") || "（无）"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">驱动 / 驱动支持的 CUDA</dt>
            <dd className="mono text-slate-300">
              {facts.driverVersion ?? "未知"} / {facts.driverMaxCuda ?? "未知"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">显卡 / 显存</dt>
            <dd className="mono text-slate-300">
              {facts.gpuName ?? "未检测到"} / {formatMiB(facts.vramTotalMiB)}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">模型 / 体积</dt>
            <dd className="mono min-w-0 break-all text-slate-300">
              {facts.modelPath === null ? "未指定" : `${facts.modelPath.split(/[\\/]/).pop() ?? ""} · ${formatMiB(facts.modelSizeMiB)}`}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">监听的端口</dt>
            <dd className="mono text-slate-300">{facts.portFree === null ? "未知" : facts.portFree ? "空闲" : "被占用"}</dd>
          </div>
        </dl>
      </Section>

      <p className="pb-2 text-[11px] leading-5 text-slate-500">
        「构建需要哪个 CUDA」是从 <span className="mono">ggml-cuda.dll</span> 的 PE 导入表里读出来的
        （CUDA 12 构建链 <span className="mono">cudart64_12.dll</span>，CUDA 13 构建链{" "}
        <span className="mono">cudart64_13.dll</span>），驱动能力来自 <span className="mono">nvidia-smi</span> 头部。
        判据都在本地，不需要联网；自检**只提示不拦截**，启动不会被它挡住。
      </p>
    </div>
  );
}
