import { useState } from "react";
import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge, Button, NumberInput, Select, TextInput, Toggle } from "./ui.tsx";

/**
 * 一行"路径"输入：标签 + 浏览按钮 + 输入框 + 可选提示。
 *
 * `suggestion` 是主进程**真正探测到**的候选路径：字段为空时渲染一个「填入」按钮。
 * 之所以要有它：输入框里的灰色文字只是 `placeholder`（示例），不是值 ——
 * 早先有人把示例当成默认值，以为 `models_dir` 已经设好，切到 router 就被
 * "没有任何可用模型"告警（踩过）。灰字能少则少，可点的按钮才是真东西。
 */
function PathRow({
  label,
  value,
  placeholder,
  hint,
  suggestion,
  onUseSuggestion,
  onPick,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  /** 探测到的候选路径；空串表示没探到 */
  suggestion?: string;
  /** 点「填入」时调用；不传则即使有 suggestion 也不显示按钮 */
  onUseSuggestion?: (path: string) => void;
  onPick: () => void;
  onChange: (next: string | null) => void;
}) {
  const canFill = value === "" && suggestion !== undefined && suggestion !== "" && onUseSuggestion !== undefined;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-400">{label}</span>
        <Button onClick={onPick} className="px-1.5 py-0.5">
          浏览…
        </Button>
      </div>
      <TextInput mono value={value} placeholder={placeholder} onChange={(next) => onChange(next === "" ? null : next)} />
      {canFill ? (
        <div className="flex items-center gap-1.5">
          <Button className="px-1.5 py-0.5" onClick={() => onUseSuggestion(suggestion)}>
            填入探测值
          </Button>
          <span className="mono truncate text-[10px] text-slate-500" title={suggestion}>
            {suggestion}
          </span>
        </div>
      ) : null}
      {hint !== undefined ? <p className="text-[10px] leading-4 text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function ModelPanel({ launcher }: { launcher: LauncherController }) {
  const {
    config,
    preview,
    status,
    busy,
    detect,
    profiles,
    profilesDir,
    settings,
    suggestions,
    update,
    pick,
    start,
    stop,
    openWebUi,
    saveProfileAs,
    loadProfile,
    removeProfile,
    revealProfiles,
    updateSettings,
  } = launcher;
  /** 新档案的输入框内容（纯界面状态，不进配置） */
  const [profileName, setProfileName] = useState("");
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
              placeholder="点「浏览…」或「填入探测值」"
              hint="router 模式必须有它：llama-server 靠这个目录列出可用模型，空着起来后一个模型都没有（presets.ini 不能代替它）"
              suggestion={suggestions.modelsDir}
              onUseSuggestion={(path) => update({ models_dir: path })}
              onPick={() => void pick("models_dir", "directory", "选择模型目录")}
              onChange={(next) => update({ models_dir: next ?? "" })}
            />
            <PathRow
              label="模型预设文件（--models-preset）"
              value={typeof config.models_preset === "string" ? config.models_preset : ""}
              placeholder="…\presets.ini"
              hint="可选：只负责给各模型覆盖参数；路径含中文时会自动拷到临时目录再传（直接传会让 llama-server 崩退）"
              suggestion={suggestions.presetPath}
              onUseSuggestion={(path) => update({ models_preset: path })}
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

      {/* ---- 配置档案：一个档案 = 一个 JSON 文件，随时切换整套「模型 + 参数」 ---- */}
      <section className="space-y-2 rounded-lg border border-[#1e2530] bg-[#11151d] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-300">配置档案</span>
          <Button onClick={() => void revealProfiles()} title={profilesDir === "" ? "档案目录" : profilesDir} className="px-1.5 py-0.5">
            打开目录
          </Button>
        </div>
        <p className="text-[10px] leading-4 text-slate-500">
          一个档案 = 目录里的一个 JSON 文件，可以直接拷给别人。载入档案会把它设为当前配置，
          之后「保存」就写回这套档案。
        </p>
        <Select
          className="w-full"
          value=""
          disabled={busy !== null}
          onChange={(next) => {
            if (next !== "") void loadProfile(next);
          }}
          options={[
            { value: "", label: profiles.length === 0 ? "（还没有档案）" : "（选择一个档案载入…）" },
            ...profiles.map((profile) => ({
              value: profile.name,
              label: `${profile.name} — ${profile.summary.mode} · ${profile.summary.model}${profile.valid ? "" : " ⚠ 无法解析"}`,
            })),
          ]}
        />
        <div className="flex gap-1">
          <TextInput value={profileName} placeholder="新档案名（例如 27B 日常）" onChange={setProfileName} />
          <Button
            disabled={busy !== null || profileName.trim() === ""}
            onClick={() => {
              const name = profileName.trim();
              if (name === "") return;
              void saveProfileAs(name).then(() => setProfileName(""));
            }}
          >
            存为档案
          </Button>
        </div>
        {profiles.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {profiles.map((profile) => (
              <span
                key={profile.name}
                className="inline-flex items-center gap-1 rounded bg-[#1b2230] px-2 py-0.5 text-[11px] text-slate-300"
                title={`${profile.summary.mode} · 端口 ${profile.summary.port ?? "?"} · ctx ${profile.summary.context ?? "?"}\n${profile.path}`}
              >
                {profile.name}
                <button
                  type="button"
                  className="text-slate-500 transition-colors hover:text-rose-300"
                  title="删除这个档案"
                  disabled={busy !== null}
                  onClick={() => void removeProfile(profile.name)}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </section>

      {/* ---- 启动器设置：开机自启与关闭窗口行为 ---- */}
      <section className="space-y-2 rounded-lg border border-[#1e2530] bg-[#11151d] p-3">
        <span className="text-xs font-semibold text-slate-300">启动器设置</span>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-slate-400">开机自启（带 --hidden，只驻留托盘）</span>
          <Toggle
            checked={settings?.openAtLogin === true}
            disabled={busy !== null || settings?.autostartSupported !== true}
            onChange={(next) => void updateSettings({ openAtLogin: next })}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-slate-400">关闭窗口时缩到托盘（服务继续跑）</span>
          <Toggle
            checked={settings?.minimizeToTray === true}
            disabled={busy !== null}
            onChange={(next) => void updateSettings({ minimizeToTray: next })}
          />
        </div>
        {settings !== null && !settings.autostartSupported ? (
          <p className="text-[10px] leading-4 text-slate-500">
            当前平台不支持开机自启（Linux 需要安装桌面项，暂未实现）。
          </p>
        ) : null}
        {settings !== null ? (
          <p className="text-[10px] leading-4 text-slate-500">
            {settings.minimizeToTray
              ? "已开启缩到托盘：点窗口的 ✕ 只是隐藏，服务不会停；真正退出请用托盘菜单的「退出」。"
              : "未开启：服务在跑时点 ✕ 会先问一次（退出并停止服务 / 缩到托盘继续跑）；服务没跑就直接退出。"}
          </p>
        ) : null}
        <div className="space-y-0.5 border-t border-[#1e2530] pt-1.5">
          <p className="text-[10px] leading-4 text-slate-400">
            {settings?.portable === true
              ? "便携模式：配置与数据都在应用目录内，%APPDATA% 里不留东西"
              : "配置与数据放在用户数据目录（应用目录不可写时的回退）"}
          </p>
          <p className="break-all text-[10px] leading-4 text-slate-500">配置：{settings?.configPath ?? "读取中…"}</p>
          <p className="break-all text-[10px] leading-4 text-slate-500">数据：{settings?.dataDir ?? "读取中…"}</p>
          <p className="break-all text-[10px] leading-4 text-slate-500">设置：{settings?.settingsPath ?? "读取中…"}</p>
        </div>
      </section>
    </aside>
  );
}
