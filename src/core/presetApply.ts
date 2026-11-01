/**
 * 把「某个模型的预设」翻译成「当前配置的补丁」—— 单模型模式复用 presets 的唯一通道。
 *
 * ## 口径（单模型与多模型必须一致）
 *
 * `presets` 不是"只有 router 才认的第二套配置"，而是**按模型的参数模板**：
 *
 * - **router**：模板渲染成 ini，经 `--models-preset` 交给 llama-server 按模型接管；
 * - **single**：没有 `--models-preset`，所以在**选中模型时把模板填进配置**，
 *   让顶层字段成为唯一真相 —— 界面看到的、命令行传的、配置文件里写的是同一份值。
 *
 * 这条口径解决的正是"配置文件里的内容在单模型下不生效"的问题（实测：single 模式下
 * `launcher.ts` 根本不渲染预设、`args.ts` 也不传 `--models-preset`）。
 *
 * ## 填充规则
 *
 * - 只填预设里**显式出现过**的键；没出现的保持配置原值。
 *   不回填默认值，否则会把用户手调过的值悄悄冲掉。
 * - 键名大小写不敏感（ini 导入的键统一小写，手写 JSON 可能不是）。
 * - 值按参数表的 `kind` 收敛：int/float 转数字、bool 认 on/off/yes/no、其余转字符串。
 *   转不出来的（例如 `ctx-size = "abc"`）不填，记进 `unknown` 让调用方如实告知。
 */

import type { PresetJson } from "./presets.ts";
import { PARAM_SPECS } from "./schema.ts";
import type { LauncherConfig, ParamSpec, ValueKind } from "./types.ts";

/** {@link configPatchFromPreset} 的结果 */
export interface PresetApplyResult {
  /** 可以直接 merge 进配置的字段补丁 */
  patch: Partial<LauncherConfig>;
  /** 真正填进去的键名（沿用预设里的原始写法，供界面展示） */
  applied: string[];
  /** 预设里有、但没能填进去的键：参数表没有对应项，或值无法转换 */
  unknown: string[];
}

/**
 * 把预设里的原始值转换成配置字段要求的类型。
 *
 * @param kind 参数表里声明的值类型
 * @param raw 预设里的原始值（来自 JSON 或 ini 导入）
 * @returns 转换后的值；无法转换时返回 `undefined`（调用方跳过而不是写个 NaN 进去）
 */
function castValue(kind: ValueKind, raw: string | number | boolean): unknown {
  if (kind === "int" || kind === "float") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    return Number.isFinite(n) ? n : undefined;
  }
  if (kind === "bool") {
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toLowerCase();
    if (s === "true" || s === "on" || s === "yes" || s === "1") return true;
    if (s === "false" || s === "off" || s === "no" || s === "0") return false;
    return undefined;
  }
  // enum / string：文本原样用，空串视为"没写"。
  // 但数字/布尔**原样保留** —— `fit-target` / `n-gpu-layers` 这类字段 kind 是 string，
  // 实际既能写 `1024` 也能写 `auto`；把 1024 转成 "1024" 会让配置里出现似数非数的值。
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  const s = String(raw).trim();
  return s === "" ? undefined : s;
}

/**
 * 从 GGUF 路径反推 preset 里的模型名（文件名去掉 `.gguf`，分片则去掉分片后缀）。
 *
 * 与 `scanModelDir` 的 `ScannedModel.name` 保持同一规则 —— 否则下拉框选出来的模型
 * 和手选文件算出来的名字会不一致，预设就查不到。
 *
 * @param path GGUF 文件路径
 * @returns 模型名；路径为空时返回空串
 */
export function modelNameFromPath(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  const stem = file.toLowerCase().endsWith(".gguf") ? file.slice(0, -".gguf".length) : file;
  const shard = /^(.*)-(\d{5})-of-(\d{5})$/i.exec(stem);
  return (shard?.[1] ?? stem).trim();
}

/**
 * 取某个模型在 presets 里的条目，翻成配置补丁。
 *
 * @param presets 配置里的 `presets` 字段（模型名 → 参数表）
 * @param modelName 模型名（GGUF 文件名去掉 `.gguf`，见 {@link modelNameFromPath}）
 * @param specs 参数表；默认用全局 {@link PARAM_SPECS}，测试时可注入
 * @returns 补丁 + 已应用/未识别的键名；模型没有预设时返回空结果（不报错）
 */
export function configPatchFromPreset(
  presets: PresetJson,
  modelName: string,
  specs: readonly ParamSpec[] = PARAM_SPECS,
): PresetApplyResult {
  const entry = presets[modelName];
  if (entry === undefined) return { patch: {}, applied: [], unknown: [] };

  // presetKey 是 llama.cpp 的键名 → 参数表里那条规格；同名只认第一条，避免重复填
  const byPresetKey = new Map<string, ParamSpec>();
  for (const spec of specs) {
    if (spec.presetKey !== undefined) byPresetKey.set(spec.presetKey.toLowerCase(), spec);
  }

  const patch: Partial<LauncherConfig> = {};
  const applied: string[] = [];
  const unknown: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(entry)) {
    const spec = byPresetKey.get(rawKey.toLowerCase());
    if (spec === undefined) {
      unknown.push(rawKey);
      continue;
    }
    const value = castValue(spec.kind, rawValue);
    if (value === undefined) {
      unknown.push(rawKey);
      continue;
    }
    (patch as Record<string, unknown>)[spec.key] = value;
    applied.push(rawKey);
  }
  return { patch, applied, unknown };
}
