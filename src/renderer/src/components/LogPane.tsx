import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEventKind } from "../../../core/logLines.ts";
import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge, Button, TextInput, formatClock } from "./ui.tsx";

type Level = "info" | "warn" | "error";

const LEVEL_TEXT: Record<Level, string> = {
  info: "text-[var(--text-secondary)]",
  warn: "text-[var(--warn)]",
  error: "text-[var(--danger)]",
};

/** 个别事件值得用更醒目的颜色，优先于等级配色 */
const KIND_TEXT: Partial<Record<LogEventKind, string>> = {
  oom: "bg-[var(--flash-danger-bg)] text-[var(--danger)]",
  listening: "text-[var(--ok)]",
  "model-loaded": "text-[var(--accent)]",
  "model-list": "text-[color-mix(in_srgb,var(--accent)_80%,transparent)]",
  perf: "text-[var(--mono-emit)]",
  error: "text-[var(--danger)]",
};

const RENDER_LIMIT = 1500;

export function LogPane({ launcher }: { launcher: LauncherController }) {
  const { logs, clearLogs } = launcher;
  const [filter, setFilter] = useState("");
  const [levels, setLevels] = useState<Record<Level, boolean>>({ info: true, warn: true, error: true });
  const [autoScroll, setAutoScroll] = useState(true);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const kept = logs.filter(
      (entry) => levels[entry.level] === true && (needle === "" || entry.line.toLowerCase().includes(needle)),
    );
    return kept.length > RENDER_LIMIT ? kept.slice(kept.length - RENDER_LIMIT) : kept;
  }, [logs, filter, levels]);

  useEffect(() => {
    const box = boxRef.current;
    if (box !== null && autoScroll) box.scrollTop = box.scrollHeight;
  }, [filtered, autoScroll]);

  const errorCount = logs.filter((entry) => entry.level === "error").length;
  const warnCount = logs.filter((entry) => entry.level === "warn").length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2">
        <div className="w-64">
          <TextInput value={filter} placeholder="过滤关键字…" onChange={setFilter} />
        </div>
        {(["info", "warn", "error"] as const).map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => setLevels((prev) => ({ ...prev, [level]: !prev[level] }))}
            className={`rounded px-2 py-0.5 text-[11px] ring-1 ring-inset transition-colors ${
              levels[level]
                ? "bg-[var(--bg-elevated)] text-[var(--text-primary)] ring-[var(--border-strong)]"
                : "bg-transparent text-[var(--text-muted)] ring-[var(--border-subtle)]"
            }`}
          >
            {level === "info" ? "信息" : level === "warn" ? "警告" : "错误"}
            {level === "warn" && warnCount > 0 ? ` ${warnCount}` : ""}
            {level === "error" && errorCount > 0 ? ` ${errorCount}` : ""}
          </button>
        ))}
        <label className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(event) => setAutoScroll(event.target.checked)}
            className="accent-[var(--accent-solid)]"
          />
          自动滚动
        </label>
        <span className="text-[11px] text-[var(--text-muted)]">
          显示 {filtered.length} / 共 {logs.length} 行
        </span>
        <div className="ml-auto">
          <Button onClick={clearLogs} disabled={logs.length === 0}>
            清空
          </Button>
        </div>
      </div>

      <div ref={boxRef} className="mono min-h-0 flex-1 overflow-auto bg-[var(--bg-input)] px-3 py-2 text-[11px] leading-[1.55]">
        {filtered.length === 0 ? (
          <p className="p-2 text-[var(--text-muted)]">
            {logs.length === 0 ? "还没有日志。点左侧「启动服务」后，llama-server 的输出会实时出现在这里。" : "没有匹配的行。"}
          </p>
        ) : (
          filtered.map((entry) => (
            <div key={entry.seq} className="flex gap-2">
              <span className="log-time shrink-0 select-none">{formatClock(entry.at)}</span>
              <span className={`min-w-0 whitespace-pre-wrap break-all ${KIND_TEXT[entry.kind] ?? LEVEL_TEXT[entry.level]}`}>
                {entry.line}
              </span>
            </div>
          ))
        )}
      </div>

      {logs.length > 0 ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border-subtle)] px-4 py-1.5">
          <Badge tone="slate">最近吞吐</Badge>
          <span className="mono text-[11px] text-[var(--mono-emit)]">{latestThroughput(logs)}</span>
        </div>
      ) : null}
    </div>
  );
}

/** 从最近若干行里找最后一次统计到的 tok/s */
function latestThroughput(logs: { metrics: { promptEvalTokPerSec?: number; evalTokPerSec?: number } }[]): string {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const metrics = logs[i]?.metrics;
    if (metrics === undefined) continue;
    if (metrics.evalTokPerSec !== undefined || metrics.promptEvalTokPerSec !== undefined) {
      const parts: string[] = [];
      if (metrics.promptEvalTokPerSec !== undefined) parts.push(`prompt ${metrics.promptEvalTokPerSec.toFixed(1)} tok/s`);
      if (metrics.evalTokPerSec !== undefined) parts.push(`生成 ${metrics.evalTokPerSec.toFixed(1)} tok/s`);
      return parts.join(" · ");
    }
  }
  return "暂无（发出一次请求后才会有统计）";
}
