import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge, Button } from "./ui.tsx";

export function TopBar({ launcher }: { launcher: LauncherController }) {
  const { detect, detectError, busy, configPath, config } = launcher;

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-[#1e2530] bg-[#0f131b] px-4 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-slate-100">llama.cpp 启动器</span>
        <span className="text-[11px] text-slate-500">core + Electron</span>
      </div>

      {detect?.build != null ? (
        <Badge tone="sky" title={detect.versionLine}>
          b{detect.build}
        </Badge>
      ) : null}
      {detect !== null && detect.ok ? (
        <Badge tone="slate" title={`--help 里解析到 ${detect.optionCount} 个选项：${detect.sections.join(" / ")}`}>
          {detect.optionCount} 个参数
        </Badge>
      ) : null}
      {detectError !== null ? (
        <Badge tone="amber" title={detectError}>
          能力探测失败
        </Badge>
      ) : null}

      <div className="min-w-0 flex-1 truncate text-[11px] text-slate-500" title={configPath}>
        配置：{configPath}
      </div>

      <div className="flex items-center gap-1.5">
        <Button onClick={() => void launcher.openConfig()} disabled={busy !== null}>
          打开配置
        </Button>
        <Button onClick={() => void launcher.save()} disabled={busy !== null || config === null}>
          保存
        </Button>
        <Button onClick={() => void launcher.saveAs()} disabled={busy !== null || config === null}>
          另存为
        </Button>
        <Button
          onClick={() => void launcher.migrate()}
          disabled={busy !== null}
          title="导入原版启动器 v1.9 的 llama_launcher_config.json（保留未知键）"
        >
          导入 v1.9
        </Button>
        <Button variant="primary" onClick={() => void launcher.refreshSchema()} disabled={busy !== null} title="重新跑 llama-server --version/--help">
          重新探测
        </Button>
      </div>
    </header>
  );
}
