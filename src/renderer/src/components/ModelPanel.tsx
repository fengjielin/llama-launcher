import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge, Button, NumberInput, Select, TextInput } from "./ui.tsx";

function PathRow({
  label,
  value,
  placeholder,
  hint,
  onPick,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  onPick: () => void;
  onChange: (next: string | null) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-400">{label}</span>
        <Button onClick={onPick} className="px-1.5 py-0.5">
          浏览…
        </Button>
      </div>
      <TextInput mono value={value} placeholder={placeholder} onChange={(next) => onChange(next === "" ? null : next)} />
      {hint !== undefined ? <p className="text-[10px] leading-4 text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function ModelPanel({ launcher }: { launcher: LauncherController }) {
  const { config, preview, status, busy, detect, update, pick, start, stop, openWebUi } = launcher;
  if (config === null) return null;

  const router = config.mode === "router";
  const running = status?.running === true;
  const presetModels = preview?.preset?.models ?? [];
  const preloadValue = typeof config.preload_model === "string" ? config.preload_model : "";
  const preloadOptions = [
    { value: "", label: "（不预加载，首次请求才加载）" },
    ...presetModels.map((model) => ({ value: model, label: model })),
    ...(preloadValue !== "" && !presetModels.includes(preloadValue)
      ? [{ value: preloadValue, label: `${preloadValue}（不在 presets.ini 里）` }]
      : []),
  ];

  return (
    <aside className="flex w-96 shrink-0 flex-col gap-3 overflow-y-auto border-r border-[#1e2530] bg-[#0f131b] px-3 py-3">
      {/* 启停控制放最上面：这是最常用的操作 */}
      <section className="rounded-lg border border-[#1e2530] bg-[#11151d] p-3">
        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="danger" className="flex-1 justify-center py-2" onClick={() => void stop()} disabled={busy !== null}>
              停止服务
            </Button>
          ) : (
            <Button
              variant="primary"
              className="flex-1 justify-center py-2"
              onClick={() => void start()}
              disabled={busy !== null}
              title="按当前参数启动 llama-server"
            >
              启动服务
            </Button>
          )}
          <Button onClick={() => void openWebUi()} disabled={!running} title="用系统浏览器打开 llama-server 自带的 WebUI">
            打开网页
          </Button>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-slate-500">{status?.note ?? "未启动"}</p>
        {running && status?.health?.state === "loading" ? (
          <p className="mt-1 text-[11px] leading-4 text-amber-300">
            服务已在监听，但模型还没加载（router 模式下点开网页就会自动加载）
          </p>
        ) : null}
      </section>

      <section className="space-y-2 rounded-lg border border-[#1e2530] bg-[#11151d] p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-300">运行模式</span>
          <div className="flex gap-1 rounded-md bg-[#0d1117] p-0.5 ring-1 ring-inset ring-[#2a3444]">
            {(["router", "single"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => update({ mode })}
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                  (config.mode ?? "single") === mode ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {mode === "router" ? "多模型 router" : "单模型"}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[10px] leading-4 text-slate-500">
          {router
            ? "router 模式：网页左上角可随时切换模型，无需重启；presets.ini 里定义过的键由 preset 按模型接管。"
            : "单模型模式：一次只起一个 -m 指定的模型，所有参数都由命令行决定。"}
        </p>
      </section>

      <section className="space-y-3 rounded-lg border border-[#1e2530] bg-[#11151d] p-3">
        <span className="text-xs font-semibold text-slate-300">模型</span>

        {router ? (
          <>
            <PathRow
              label="模型目录（--models-dir）"
              value={typeof config.models_dir === "string" ? config.models_dir : ""}
              placeholder="E:\Code\llama\models"
              hint="目录里的 .gguf 会被自动识别；分片模型请各自放独立子目录"
              onPick={() => void pick("models_dir", "directory", "选择模型目录")}
              onChange={(next) => update({ models_dir: next ?? "" })}
            />
            <PathRow
              label="模型预设文件（--models-preset）"
              value={typeof config.models_preset === "string" ? config.models_preset : ""}
              placeholder="…\presets.ini"
              hint="路径含中文时会自动拷到临时目录再传（直接传会让 llama-server 崩退）"
              onPick={() => void pick("models_preset", "ini", "选择 presets.ini")}
              onChange={(next) => update({ models_preset: next ?? "" })}
            />
            <div className="space-y-1">
              <span className="text-[11px] text-slate-400">启动预加载模型</span>
              <Select
                className="w-full"
                value={preloadValue}
                options={preloadOptions}
                onChange={(next) => update({ preload_model: next })}
              />
              <p className="text-[10px] leading-4 text-slate-500">
                预加载的模型实测【不吃 preset】，所以 ctx / KV / fit 等参数会改由命令行直传。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400">同时加载模型数</span>
              <NumberInput
                value={typeof config.models_max === "number" ? config.models_max : null}
                placeholder="默认"
                onChange={(next) => update({ models_max: next })}
              />
            </div>
          </>
        ) : (
          <PathRow
            label="主模型（-m）"
            value={typeof config.main_model === "string" ? config.main_model : ""}
            placeholder="E:\Code\llama\models\xxx.gguf"
            onPick={() => void pick("main_model", "gguf", "选择主模型")}
            onChange={(next) => update({ main_model: next ?? "" })}
          />
        )}

        <PathRow
          label="视觉投影文件（--mmproj）"
          value={typeof config.vision_model === "string" ? config.vision_model : ""}
          placeholder="多模态模型才需要"
          onPick={() => void pick("vision_model", "gguf", "选择 mmproj 文件")}
          onChange={(next) => update({ vision_model: next ?? "" })}
        />

        <PathRow
          label="草稿模型（--spec-draft-model）"
          value={typeof config.draft_model === "string" ? config.draft_model : ""}
          placeholder="推测解码才需要"
          hint="b10488 起改名为 --spec-draft-model；dflash / dspark / MTP 需要 b10679+ 开发版"
          onPick={() => void pick("draft_model", "gguf", "选择草稿模型")}
          onChange={(next) => update({ draft_model: next ?? "" })}
        />
      </section>

      <section className="space-y-2 rounded-lg border border-[#1e2530] bg-[#11151d] p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-300">llama.cpp</span>
          {detect?.build != null ? <Badge tone="sky">b{detect.build}</Badge> : <Badge tone="amber">未探测</Badge>}
        </div>
        <PathRow
          label="构建目录"
          value={typeof config.llama_dir === "string" ? config.llama_dir : ""}
          placeholder="E:\Code\llama\llama.cpp"
          hint="目录里要有 llama-server.exe 和它旁边的 DLL"
          onPick={() => void pick("llama_dir", "directory", "选择 llama.cpp 目录")}
          onChange={(next) => update({ llama_dir: next ?? "" })}
        />
        {detect !== null && detect.ok ? (
          <p className="text-[10px] leading-4 text-slate-500">
            参数名已改名 {detect.renamed.length} 项 · 本版本不支持 {detect.unsupported.length} 项 · 已废弃{" "}
            {detect.deprecated.length} 项
          </p>
        ) : null}
      </section>
    </aside>
  );
}
