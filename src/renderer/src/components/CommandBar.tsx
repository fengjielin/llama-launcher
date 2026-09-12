import { useState } from "react";
import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge, Button, copyText } from "./ui.tsx";

export function CommandBar({ launcher }: { launcher: LauncherController }) {
  const { preview, previewError, warnings, lastStart } = launcher;
  const [copied, setCopied] = useState(false);
  const command = preview?.command ?? "";
  const failed = lastStart !== null && !lastStart.report.ready;

  return (
    <div className="shrink-0 space-y-2 border-b border-[#1e2530] bg-[#0d1117] px-4 py-3">
      <div className="flex items-start gap-2">
        <Badge tone="violet">实际启动命令</Badge>
        <code className="mono min-w-0 flex-1 break-all rounded-md border border-[#1e2530] bg-[#0b0e14] px-2 py-1.5 text-[11px] leading-relaxed text-emerald-300">
          {previewError !== null
            ? `拼装失败：${previewError}`
            : command === ""
              ? "（正在拼装…）"
              : command}
        </code>
        <Button
          disabled={command === ""}
          onClick={() => {
            void copyText(command).then((ok) => {
              setCopied(ok);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "已复制" : "复制"}
        </Button>
      </div>

      {preview !== null && Object.keys(preview.env).length > 0 ? (
        <div className="flex items-start gap-2">
          <Badge tone="amber">环境变量</Badge>
          <div className="mono min-w-0 flex-1 space-y-0.5 text-[11px] text-amber-200">
            {Object.entries(preview.env).map(([key, value]) => (
              <div key={key} className="break-all">
                {key}={value}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {failed && lastStart?.report.diagnosis !== null && lastStart !== null ? (
        <div className="rounded-md border border-rose-900/60 bg-rose-950/30 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Badge tone="rose">启动失败</Badge>
            <span className="text-xs text-rose-200">{lastStart.report.note}</span>
          </div>
          {lastStart.report.diagnosis !== null ? (
            <div className="mt-1.5 space-y-1">
              <p className="text-xs font-medium text-rose-200">{lastStart.report.diagnosis.summary}</p>
              <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-rose-200/80">
                {lastStart.report.diagnosis.suggestions.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="space-y-0.5">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5 text-[11px] text-amber-300">
              <span className="shrink-0">⚠</span>
              <span className="min-w-0 break-words">{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
