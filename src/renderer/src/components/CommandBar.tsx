import { useState } from "react";
import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge, Button, copyText } from "./ui.tsx";

export function CommandBar({ launcher }: { launcher: LauncherController }) {
  const { preview, previewError, warnings, notices, lastStart } = launcher;
  const [copied, setCopied] = useState(false);
  const command = preview?.command ?? "";
  const failed = lastStart !== null && !lastStart.report.ready;

  return (
    <div className="shrink-0 space-y-2 border-b border-[var(--border-subtle)] bg-[var(--bg-command)] px-4 py-3">
      <div className="flex items-start gap-2">
        <span className="mt-1 shrink-0 text-[11px] font-medium text-[var(--text-muted)]">实际启动命令</span>
        <code className="mono min-w-0 flex-1 break-all rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--mono-emit)]">
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
          <div className="mono min-w-0 flex-1 space-y-0.5 text-[11px] text-[var(--mono-env)]">
            {Object.entries(preview.env).map(([key, value]) => (
              <div key={key} className="break-all">
                {key}={value}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {failed && lastStart?.report.diagnosis !== null && lastStart !== null ? (
        <div className="rounded-md border border-[var(--diag-danger-border)] bg-[var(--diag-danger-bg)] px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Badge tone="rose">启动失败</Badge>
            <span className="text-xs text-[var(--danger)]">{lastStart.report.note}</span>
          </div>
          {lastStart.report.diagnosis !== null ? (
            <div className="mt-1.5 space-y-1">
              <p className="text-xs font-medium text-[var(--danger)]">{lastStart.report.diagnosis.summary}</p>
              <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-[color-mix(in_srgb,var(--danger)_80%,transparent)]">
                {lastStart.report.diagnosis.suggestions.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {notices.length > 0 ? (
        <ul className="space-y-0.5">
          {notices.map((notice) => (
            <li key={notice} className="flex items-start gap-1.5 text-[11px] text-[var(--text-secondary)]">
              <span className="shrink-0 text-[var(--info)]">ℹ</span>
              <span className="min-w-0 break-words">{notice}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="space-y-0.5">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5 text-[11px] text-[var(--warn)]">
              <span className="shrink-0">⚠</span>
              <span className="min-w-0 break-words">{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
