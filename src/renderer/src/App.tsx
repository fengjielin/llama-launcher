import { useEffect, useState } from "react";
import { CommandBar } from "./components/CommandBar.tsx";
import { DecisionTable } from "./components/DecisionTable.tsx";
import { LogPane } from "./components/LogPane.tsx";
import { ModelPanel } from "./components/ModelPanel.tsx";
import { ParamsForm, MODEL_PANEL_KEYS } from "./components/ParamsForm.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { Badge, Button } from "./components/ui.tsx";
import { useLauncher } from "./hooks/useLauncher.ts";

type Tab = "params" | "decision" | "logs";

const TABS: { id: Tab; label: string }[] = [
  { id: "params", label: "参数" },
  { id: "decision", label: "决策表" },
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
        <div className="max-w-xl space-y-3 rounded-lg border border-amber-900/50 bg-amber-950/20 p-5">
          <h1 className="text-sm font-semibold text-amber-200">这个界面需要通过 Electron 启动</h1>
          <p className="text-xs leading-6 text-amber-200/80">
            界面拿不到 <span className="mono">window.llamaApi</span>（preload 注入的桥），说明它是被浏览器直接打开的。
            请用桌面壳启动：
          </p>
          <pre className="mono rounded bg-[#0b0e14] px-3 py-2 text-[11px] text-slate-300">pnpm dev        # 开发模式
pnpm build && pnpm start   # 构建后运行</pre>
          <p className="text-xs leading-6 text-amber-200/80">
            只是想跑服务的话，core 本身不依赖界面：
            <span className="mono"> pnpm args</span> 看命令行、<span className="mono">pnpm run</span> 直接启动。
          </p>
        </div>
      </div>
    );
  }

  if (!launcher.ready) {
    return <div className="flex h-full items-center justify-center text-xs text-slate-500">正在初始化…</div>;
  }

  const steps = launcher.preview?.steps.length ?? 0;
  // 参数页只展示不在左侧「模型」面板里的项，计数也要跟着一致
  const paramCount = (launcher.schema?.entries ?? []).filter((entry) => !MODEL_PANEL_KEYS.has(entry.key)).length;

  return (
    <div className="flex h-full flex-col">
      <TopBar launcher={launcher} />

      {launcher.error !== null ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-rose-900/50 bg-rose-950/30 px-4 py-1.5">
          <Badge tone="rose">出错</Badge>
          <span className="min-w-0 flex-1 text-xs text-rose-200">{launcher.error}</span>
          <Button variant="ghost" onClick={launcher.dismissError}>
            知道了
          </Button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <ModelPanel launcher={launcher} />

        <main className="flex min-w-0 flex-1 flex-col">
          <CommandBar launcher={launcher} />

          <nav className="flex shrink-0 items-center gap-1 border-b border-[#1e2530] px-4">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`-mb-px border-b-2 px-3 py-2 text-xs transition-colors ${
                  tab === item.id
                    ? "border-sky-500 text-slate-100"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                {item.label}
                <span className="ml-1.5 text-[10px] text-slate-600">
                  {item.id === "params"
                    ? paramCount
                    : item.id === "decision"
                      ? steps
                      : launcher.logs.length}
                </span>
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-hidden">
            {tab === "params" ? <ParamsForm launcher={launcher} /> : null}
            {tab === "decision" ? <DecisionTable launcher={launcher} /> : null}
            {tab === "logs" ? <LogPane launcher={launcher} /> : null}
          </div>
        </main>
      </div>

      <StatusBar launcher={launcher} />
    </div>
  );
}
