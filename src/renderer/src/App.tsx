import { useEffect, useState } from "react";
import { CommandBar } from "./components/CommandBar.tsx";
import { DecisionTable } from "./components/DecisionTable.tsx";
import { LogPane } from "./components/LogPane.tsx";
import { MetricsPanel } from "./components/MetricsPanel.tsx";
import { ModelPanel } from "./components/ModelPanel.tsx";
import { ParamsForm, MODEL_PANEL_KEYS } from "./components/ParamsForm.tsx";
import { PrecheckPanel } from "./components/PrecheckPanel.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { Badge, Button } from "./components/ui.tsx";
import { useLauncher } from "./hooks/useLauncher.ts";

type Tab = "params" | "decision" | "precheck" | "metrics" | "logs";

const TABS: { id: Tab; label: string }[] = [
  { id: "params", label: "参数" },
  { id: "decision", label: "决策表" },
  { id: "precheck", label: "自检" },
  { id: "metrics", label: "监控" },
  { id: "logs", label: "日志" },
];

export default function App() {
  const launcher = useLauncher();
  const [tab, setTab] = useState<Tab>("params");

  // 启动失败时自动切到日志页，省得用户还要自己找
  useEffect(() => {
    if (launcher.lastStart !== null && !launcher.lastStart.report.ready) setTab("logs");
  }, [launcher.lastStart]);

  if (launcher.bridgeMissing) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-xl space-y-3 rounded-md border border-[var(--flash-ok-border)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] p-5">
          <h1 className="text-sm font-semibold text-[var(--warn)]">这个界面需要通过 Electron 启动</h1>
          <p className="text-xs leading-6 text-[color-mix(in_srgb,var(--warn)_80%,transparent)]">
            界面拿不到 <span className="mono">window.llamaApi</span>（preload 注入的桥），说明它是被浏览器直接打开的。
            请用桌面壳启动：
          </p>
          <pre className="mono rounded bg-[var(--bg-input)] px-3 py-2 text-[11px] text-[var(--text-secondary)]">pnpm dev        # 开发模式
pnpm build && pnpm start   # 构建后运行</pre>
          <p className="text-xs leading-6 text-[color-mix(in_srgb,var(--warn)_80%,transparent)]">
            只是想跑服务的话，core 本身不依赖界面：
            <span className="mono"> pnpm args</span> 看命令行、<span className="mono">pnpm run</span> 直接启动。
          </p>
        </div>
      </div>
    );
  }

  if (!launcher.ready) {
    return <div className="flex h-full items-center justify-center text-xs text-[var(--text-muted)]">正在初始化…</div>;
  }

  const steps = launcher.preview?.steps.length ?? 0;
  // 参数页只展示不在左侧「模型」面板里的项，计数也要跟着一致
  const paramCount = (launcher.schema?.entries ?? []).filter((entry) => !MODEL_PANEL_KEYS.has(entry.key)).length;
  /** 标签页角标：各页各取一个有代表性的数量 */
  const tabCount = (id: Tab): number => {
    if (id === "params") return paramCount;
    if (id === "decision") return steps;
    if (id === "precheck") {
      // 自检页只统计"要看一眼"的项（error + warn），全是绿色时角标为 0
      return (launcher.precheck?.items ?? []).filter((item) => item.level === "error" || item.level === "warn").length;
    }
    if (id === "metrics") return launcher.metrics?.series.at.length ?? 0;
    return launcher.logs.length;
  };
  /** 自检发现"会导致启动失败"的项时，在命令行栏上给一条醒目的提示 */
  const precheckErrors = (launcher.precheck?.items ?? []).filter((item) => item.level === "error");

  return (
    <div className="flex h-full flex-col bg-[var(--bg-app)]">
      <TopBar launcher={launcher} />

      {launcher.flash !== null ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--flash-ok-border)] bg-[var(--flash-ok-bg)] px-4 py-1.5">
          <Badge tone="emerald">完成</Badge>
          <span className="min-w-0 flex-1 text-xs text-[var(--ok)]">{launcher.flash}</span>
          <Button variant="ghost" onClick={launcher.dismissFlash}>
            知道了
          </Button>
        </div>
      ) : null}

      {launcher.error !== null ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--flash-danger-border)] bg-[var(--flash-danger-bg)] px-4 py-1.5">
          <Badge tone="rose">出错</Badge>
          <span className="min-w-0 flex-1 text-xs text-[var(--danger)]">{launcher.error}</span>
          <Button variant="ghost" onClick={launcher.dismissError}>
            知道了
          </Button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <ModelPanel launcher={launcher} />

        <main className="flex min-w-0 flex-1 flex-col">
          <CommandBar launcher={launcher} />

          {precheckErrors.length > 0 ? (
            <div className="flex shrink-0 items-start gap-2 border-b border-[var(--flash-danger-border)] bg-[var(--flash-danger-bg)] px-4 py-1.5">
              <Badge tone="rose">环境自检不通过</Badge>
              <span className="min-w-0 flex-1 text-xs text-[var(--danger)]">
                {precheckErrors.map((item) => item.title).join("；")}
              </span>
              <Button variant="ghost" onClick={() => setTab("precheck")}>
                查看自检
              </Button>
            </div>
          ) : null}

          <nav className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-4">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`-mb-px border-b-2 px-3 py-2 text-xs transition-colors ${
                  tab === item.id
                    ? "border-[var(--accent)] text-[var(--text-primary)]"
                    : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                }`}
              >
                {item.label}
                <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">{tabCount(item.id)}</span>
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-hidden">
            {tab === "params" ? <ParamsForm launcher={launcher} /> : null}
            {tab === "decision" ? <DecisionTable launcher={launcher} /> : null}
            {tab === "precheck" ? <PrecheckPanel launcher={launcher} /> : null}
            {/* 监控页自己管采样的开关（挂载开、卸载关），所以只在激活时渲染 */}
            {tab === "metrics" ? <MetricsPanel launcher={launcher} /> : null}
            {tab === "logs" ? <LogPane launcher={launcher} /> : null}
          </div>
        </main>
      </div>

      <StatusBar launcher={launcher} />
    </div>
  );
}
