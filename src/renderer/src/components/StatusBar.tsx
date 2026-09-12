import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge } from "./ui.tsx";
import type { Tone } from "./ui.tsx";

const STATE_TONE: Record<string, Tone> = {
  idle: "slate",
  starting: "amber",
  running: "emerald",
  stopping: "amber",
  exited: "slate",
  failed: "rose",
};

const HEALTH_LABEL: Record<string, { tone: Tone; text: string; title: string }> = {
  // 注意用词：/health 返回 200 只代表"服务就绪"，router 模式下模型可能还没加载
  // （实测未加载模型时 /health 就是 200，别写成"模型就绪"误导人）
  ready: { tone: "emerald", text: "服务就绪", title: "/health 返回 200：服务可用；router 模式下模型可能仍是按需加载" },
  loading: { tone: "amber", text: "模型加载中", title: "/health 返回 503：服务在监听，但模型还没加载完" },
  error: { tone: "rose", text: "健康检查异常", title: "/health 返回了非 200/503 的状态" },
  unreachable: { tone: "slate", text: "未监听", title: "连接被拒，服务还没起来" },
};

export function StatusBar({ launcher }: { launcher: LauncherController }) {
  const { status, logs, busy } = launcher;
  const state = status?.state ?? "idle";
  const health = status?.health ?? null;

  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-[#1e2530] bg-[#0f131b] px-4 py-1.5 text-[11px] text-slate-500">
      <Badge tone={STATE_TONE[state] ?? "slate"} title={status?.note ?? ""}>
        {state}
      </Badge>
      <span className="min-w-0 truncate" title={status?.note ?? ""}>
        {status?.note ?? "未启动"}
      </span>

      {status?.pid != null ? <span className="mono">PID {status.pid}</span> : null}

      <span className="mono truncate" title={status?.baseUrl ?? ""}>
        {status?.baseUrl ?? ""}
      </span>

      {health !== null ? (
        <Badge tone={HEALTH_LABEL[health.state]?.tone ?? "slate"} title={HEALTH_LABEL[health.state]?.title ?? ""}>
          {HEALTH_LABEL[health.state]?.text ?? health.state}
        </Badge>
      ) : null}

      <span className="ml-auto flex items-center gap-3">
        {busy !== null ? <span className="text-sky-400">进行中：{busy}</span> : null}
        <span>日志 {logs.length} 行</span>
      </span>
    </footer>
  );
}
