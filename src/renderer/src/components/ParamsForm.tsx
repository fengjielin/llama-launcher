import { useState } from "react";
import type { ReactNode } from "react";
import type { LauncherConfig, ParamGroup } from "../../../core/types.ts";
import type { SchemaEntry } from "../../../shared/ipc.ts";
import type { LauncherController } from "../hooks/useLauncher.ts";
import { Badge, NumberInput, Select, TextInput, Toggle } from "./ui.tsx";
import type { Tone } from "./ui.tsx";

/**
 * 这些键由左侧「模型」面板负责，参数表里不再重复出现。
 *
 * 必须共享同一份清单：否则同一个字段会在两处渲染，改动不同步时
 * 会出现"左边显示 A、右边显示 B"的假象。`App` 里的参数计数也用它来对齐。
 */
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

/**
 * 按参数类型渲染对应的输入控件。
 *
 * 判定顺序（enum 在前，因为它的 `kind` 可能是 string）：
 * 1. `bool` → 开关
 * 2. 有 `enumValues` → 下拉框，并额外提供一个"（用 llama.cpp 默认）"空选项
 * 3. `int` / `float` → 数字框（float 的步长给 0.05，采样参数常用这个量级）
 * 4. 其余 → 文本框（`mono`，因为里面常是路径或参数名）
 *
 * 约定：**清空输入表示"不传这个参数"，一律写回 `null`**（而不是空串）——
 * 拼装层靠"值为 null/空串"来决定跳过，用空串容易在别处被当成有效值。
 *
 * @param entry 参数定义（决定用哪种控件、下拉选项有哪些）
 * @param value 当前值（来自配置，可能是任意类型）
 * @param set 值变更回调
 * @param disabled 是否禁用（该参数在当前 llama.cpp 版本不存在时禁用）
 * @returns 对应的 React 节点
 */
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

/**
 * 渲染一个参数行右侧的状态徽标，回答"这个参数现在到底是什么情况"。
 *
 * 四类徽标（可能同时出现多个）：
 * - `本版本不支持`：当前 llama.cpp 没有对应参数名，控件会一并置灰
 * - `未探测`：还没跑过 `--help`，支持情况未知
 * - `已废弃`：命中的参数在 help 里被标了 `DEPRECATED`
 * - `preset 接管`：**仅当该参数有值时才显示** —— 没配却提示"被 preset 接管"会让人误解；
 *   含义是"命令行不会再传它，改由配置里的 presets 决定"
 *
 * @param entry 参数定义（提供支持情况、实际参数名、preset 键）
 * @param presetOwned 该参数的 preset 键是否出现在配置的 presets 里
 * @param raw 该参数的当前配置值（用于判断"有没有配"）
 * @returns 徽标节点；都不满足时返回空片段
 */
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
        "配置里的 presets 为某个模型定义过这个键，命令行不会再传它（实测命令行优先级更高，传了会盖掉 preset）。预加载的模型除外。",
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

/**
 * schema 驱动的参数表单：按分组折叠展示全部参数，逐项渲染控件与状态徽标。
 *
 * 之所以整表由 `schema` 生成而不是手写 JSX：llama.cpp 有一百多个参数且改名频繁，
 * 手写必然跟不上；这里只负责"怎么展示"，"有哪些参数、叫什么名字、支不支持"
 * 全部来自主进程下发的参数表。
 *
 * 折叠状态是纯界面状态（`collapsed`），不进配置，所以不参与"配置变化 → 重拼命令行"。
 *
 * @param props.launcher 界面状态控制器（取 schema/config/preview，写回用 `update`）
 * @returns 表单节点；配置或参数表还没加载完时返回 `null`（不渲染空表单）
 */
export function ParamsForm({ launcher }: { launcher: LauncherController }) {
  const { schema, config, preview, update } = launcher;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (schema === null || config === null) return null;

  // presets.ini 里出现过的键：用于给对应参数打「preset 接管」徽标
  const presetKeys = new Set(preview?.preset?.presetKeys ?? []);
  // 按分组归类，并跳过由左侧「模型」面板负责的字段（避免同一字段两处渲染）
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
