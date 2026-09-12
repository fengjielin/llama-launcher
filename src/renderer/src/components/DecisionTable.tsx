import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge } from "./ui.tsx";
import type { Tone } from "./ui.tsx";

const REASON_TONE: Record<string, Tone> = {
  cli: "emerald",
  "preload-override": "violet",
  "preset-owned": "amber",
  unsupported: "rose",
  fallback: "amber",
  skipped: "slate",
  unset: "slate",
};

/** 这些原因代表"参数确实被传进去了" */
const EMITTED = new Set(["cli", "preload-override", "fallback"]);

export function DecisionTable({ launcher }: { launcher: LauncherController }) {
  const { preview, previewError } = launcher;

  if (previewError !== null) {
    return <div className="p-4 text-xs text-rose-300">命令行拼装失败：{previewError}</div>;
  }
  if (preview === null) {
    return <div className="p-4 text-xs text-slate-500">正在拼装…</div>;
  }

  const counts = new Map<string, number>();
  for (const step of preview.steps) {
    counts.set(step.reason, (counts.get(step.reason) ?? 0) + 1);
  }
  const emitted = preview.steps.filter((step) => EMITTED.has(step.reason)).length;

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone="sky">
          共 {preview.steps.length} 项，实际传入 {emitted} 项
        </Badge>
        {[...counts.entries()].map(([reason, count]) => (
          <Badge key={reason} tone={REASON_TONE[reason] ?? "slate"}>
            {preview.steps.find((step) => step.reason === reason)?.reasonLabel ?? reason} {count}
          </Badge>
        ))}
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[#1e2530] text-left text-[11px] text-slate-500">
            <th className="py-1.5 pr-3 font-medium">原因</th>
            <th className="py-1.5 pr-3 font-medium">参数</th>
            <th className="py-1.5 pr-3 font-medium">实际传入</th>
            <th className="py-1.5 font-medium">说明</th>
          </tr>
        </thead>
        <tbody>
          {preview.steps.map((step) => (
            <tr key={step.key} className="border-b border-[#161b24] align-top">
              <td className="whitespace-nowrap py-1.5 pr-3">
                <Badge tone={REASON_TONE[step.reason] ?? "slate"}>{step.reasonLabel}</Badge>
              </td>
              <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-slate-300">{step.label}</td>
              <td className="mono py-1.5 pr-3 text-[11px] break-all text-emerald-300">
                {step.argvText === "" ? <span className="text-slate-600">—</span> : step.argvText}
              </td>
              <td className="py-1.5 text-[11px] leading-5 text-slate-500">{step.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
