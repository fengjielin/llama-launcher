import { useState } from "react";
import type { ReactNode } from "react";
import type { LauncherConfig, ParamGroup } from "../../../core/types.ts";
import type { SchemaEntry } from "../../../shared/ipc.ts";
import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge, NumberInput, Select, TextInput, Toggle } from "./ui.tsx";
import type { Tone } from "./ui.tsx";

/** 这些键由左侧「模型」面板负责，参数表里不再重复出现 */
export const MODEL_PANEL_KEYS: ReadonlySet<string> = new Set([
  "llama_dir",
  "main_model",
  "models_dir",
  "models_preset",
  "models_max",
  "preload_model",
  "vision_model",
  "draft_model",
]);

function controlFor(
  entry: SchemaEntry,
  value: unknown,
  set: (next: unknown) => void,
  disabled: boolean,
): ReactNode {
  if (entry.kind === "bool") {
    return <Toggle checked={value === true} onChange={set} disabled={disabled} />;
  }

  if (entry.enumValues !== undefined && entry.enumValues.length > 0) {
    return (
      <Select
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(next) => set(next === "" ? null : next)}
        options={[{ value: "", label: "（用 llama.cpp 默认）" }, ...entry.enumValues.map((v) => ({ value: v, label: v }))]}
      />
    );
  }

  if (entry.kind === "int" || entry.kind === "float") {
    return (
      <NumberInput
        value={typeof value === "number" ? value : null}
        step={entry.kind === "float" ? 0.05 : 1}
        disabled={disabled}
        placeholder="默认"
        onChange={set}
      />
    );
  }

  return (
    <TextInput
      mono
      disabled={disabled}
      value={value === undefined || value === null ? "" : String(value)}
      placeholder={entry.candidates[0] ?? ""}
      onChange={(next) => set(next === "" ? null : next)}
    />
  );
}

function Badges({
  entry,
  presetOwned,
  raw,
}: {
  entry: SchemaEntry;
  presetOwned: boolean;
  raw: unknown;
}): ReactNode {
  const items: { text: string; tone: Tone; title: string }[] = [];

  if (entry.supported === false) {
    items.push({
      text: "本版本不支持",
      tone: "rose",
      title: `当前 llama.cpp 没有这些参数：${entry.candidates.join(" / ")}`,
    });
  } else if (entry.supported === null) {
    items.push({ text: "未探测", tone: "slate", title: "还没跑过 llama-server --help，点右上角「重新探测」" });
  }

  if (entry.deprecated) {
    items.push({
      text: "已废弃",
      tone: "amber",
      title: `${entry.resolvedFlag ?? ""} 在 --help 里被标为 DEPRECATED，建议改用替代参数`,
    });
  }

  if (presetOwned && raw !== null && raw !== undefined && raw !== "") {
    items.push({
      text: "preset 接管",
      tone: "violet",
      title:
        "presets.ini 的模型段里定义过这个键，命令行不会再传它（实测命令行优先级更高，传了会盖掉 preset）。预加载的模型除外。",
    });
  }

  return (
    <>
      {items.map((item) => (
        <Badge key={item.text} tone={item.tone} title={item.title}>
          {item.text}
        </Badge>
      ))}
    </>
  );
}

export function ParamsForm({ launcher }: { launcher: LauncherController }) {
  const { schema, config, preview, update } = launcher;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (schema === null || config === null) return null;

  const presetKeys = new Set(preview?.preset?.presetKeys ?? []);
  const byGroup = new Map<ParamGroup, SchemaEntry[]>();
  for (const entry of schema.entries) {
    if (MODEL_PANEL_KEYS.has(entry.key)) continue;
    const list = byGroup.get(entry.group) ?? [];
    list.push(entry);
    byGroup.set(entry.group, list);
  }

  return (
    <div className="h-full space-y-3 overflow-y-auto px-4 py-3">
      {schema.groups.map((group) => {
        const entries = byGroup.get(group.id) ?? [];
        if (entries.length === 0) return null;
        const open = collapsed[group.id] !== true;
        const unsupported = entries.filter((entry) => entry.supported === false).length;
        return (
          <section key={group.id} className="rounded-lg border border-[#1e2530] bg-[#11151d]">
            <button
              type="button"
              onClick={() => setCollapsed((prev) => ({ ...prev, [group.id]: open }))}
              className="flex w-full items-center gap-2 px-3 py-2 text-left"
            >
              <span className="text-slate-500">{open ? "▾" : "▸"}</span>
              <span className="text-xs font-semibold text-slate-200">{group.label}</span>
              <span className="text-[11px] text-slate-500">{entries.length} 项</span>
              {unsupported > 0 ? <Badge tone="rose">{unsupported} 项不支持</Badge> : null}
            </button>

            {open ? (
              <div className="border-t border-[#1e2530] px-3 py-2">
                {entries.map((entry) => {
                  const raw = config[entry.key];
                  const presetOwned = entry.presetKey !== undefined && presetKeys.has(entry.presetKey);
                  const disabled = entry.supported === false;
                  return (
                    <div
                      key={entry.key}
                      className="flex items-start gap-3 border-b border-[#161b24] py-2 last:border-b-0"
                      title={entry.hint ?? ""}
                    >
                      <div className="min-w-[168px] shrink-0 space-y-0.5">
                        <div className="text-xs text-slate-300">{entry.label}</div>
                        <div className="mono flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
                          <span>{entry.resolvedFlag ?? entry.candidates[0] ?? entry.key}</span>
                          {entry.kind === "bool" ? null : entry.takesValue === false ? <span>（开关）</span> : null}
                        </div>
                      </div>

                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                        {controlFor(entry, raw, (next) => update({ [entry.key]: next }), disabled)}
                        <Badges entry={entry} presetOwned={presetOwned} raw={raw} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        );
      })}

      <p className="pb-2 text-[11px] leading-5 text-slate-500">
        提示：把鼠标停在任意一行上会显示该参数的踩坑说明。凡是标了「本版本不支持」的项，说明当前 llama.cpp 的
        <span className="mono"> --help </span>
        里没有对应参数名——启动器不会硬传，只会在决策表里记一条原因。
      </p>
    </div>
  );
}
