/**
 * presets.ini 解析（llama-server 的 --models-preset 文件）。
 *
 * 实测约束（来自 llama-oneclick.ps1 的踩坑记录，全部保留为代码里的规则）：
 *   1. 段名 = 模型名（GGUF 文件名去掉 .gguf）；`[*]` 通配段不被支持。
 *   2. 文件必须是 UTF-8 且【不带 BOM】，否则 llama-server 直接报
 *      "failed to parse server config file"。
 *   3. preset 与命令行同时给同一个键时，命令行优先级更高（实测），
 *      所以 preset 里定义过的键，命令行不能再传。
 *   4. `--models-preset` 的路径含非 ASCII 字符（如中文目录名）会让 llama-server
 *      刷两行日志后立刻崩退 → 需要先拷到 ASCII 路径再传。
 *   5. `[defaults]` 段里只能写注释形式的 `; default-model = xxx`，
 *      写未注释的自定义键会让 llama-server 报 option not recognized 直接退出。
 */

import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 只有启动器自己关心的段名。
 *
 * 实测（b10488）：llama-server **不会**忽略 `[defaults]`，而是把它当成一个名叫
 * "defaults" 的模型 —— 启动日志里会出现
 *   `Loaded 6 custom model presets` / `Available models (6)` 且其中一行是 `* defaults`，
 * 于是网页下拉框里多出一个假模型，还白占一个 --models-max 槽位。
 * 所以传给 llama-server 的那份文件要把这些段剔掉（读配置仍然从原文件读）。
 */
export const LAUNCHER_ONLY_SECTIONS: readonly string[] = ["defaults"];

export interface PresetFile {
  /** 段落名 → 键值（键名统一小写，取原始键名时用 rawKeys） */
  sections: Map<string, Map<string, string>>;
  /** [defaults] 段里的 default-model（注释形式也认） */
  defaultModel: string | null;
  /** 各段出现的键名原始大小写，用于展示 */
  rawKeys: Map<string, string[]>;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parsePresetsIni(text: string): PresetFile {
  const sections = new Map<string, Map<string, string>>();
  const rawKeys = new Map<string, string[]>();
  let defaultModel: string | null = null;
  let current: string | null = null;

  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    // 注意：先 trim 再判注释 —— [defaults] 段的 default-model 约定就是写在注释里
    const line = rawLine.trim();
    if (line === "") continue;

    const sec = /^\[(.+?)\]$/.exec(line);
    if (sec && sec[1]) {
      current = sec[1];
      if (!sections.has(current)) {
        sections.set(current, new Map());
        rawKeys.set(current, []);
      }
      continue;
    }

    if (current === null) continue;

    // 键值：允许前面有 ; 或 #（[defaults] 段靠这个约定传递 default-model）
    const kv = /^[;#]?\s*([A-Za-z0-9_\-.]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!kv || !kv[1]) continue;
    const key = kv[1];
    const value = kv[2] ?? "";

    if (current === "defaults") {
      if (key.toLowerCase() === "default-model" && value !== "") defaultModel = value;
      continue;
    }

    sections.get(current)!.set(key.toLowerCase(), value);
    const list = rawKeys.get(current)!;
    if (!list.includes(key)) list.push(key);
  }

  return { sections, defaultModel, rawKeys };
}

/**
 * 收集「所有模型段出现过的键」的并集。
 *
 * 与 llama-oneclick.ps1 的行为保持一致：只要【任意】模型段定义了某个键，
 * 命令行就不再传这个参数（交给 preset 按模型接管）。
 * 语义上更精确的做法是只看当前模型段（`presetKeysForModel`），
 * 但默认保持并集以对齐既有行为。
 */
export function collectPresetKeys(file: PresetFile): string[] {
  const keys = new Set<string>();
  for (const [name, map] of file.sections) {
    if (name === "defaults") continue;
    for (const k of map.keys()) keys.add(k);
  }
  return [...keys];
}

/** 只看指定模型段定义过的键 */
export function presetKeysForModel(file: PresetFile, modelId: string): string[] {
  const map = file.sections.get(modelId);
  return map ? [...map.keys()] : [];
}

/** 取某个模型段的数值型配置（如 ctx-size） */
export function getNumericPresetValue(file: PresetFile, modelId: string, key: string): number | null {
  const map = file.sections.get(modelId);
  if (!map) return null;
  const raw = map.get(key.toLowerCase());
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** 路径里是否有非 ASCII 字符（llama-server 处理 --models-preset 时会崩） */
export function hasNonAsciiPath(path: string): boolean {
  return /[^\x20-\x7e]/.test(path);
}

/**
 * 生成「只含模型段」的 presets 文本：剔除启动器自用的段（见 LAUNCHER_ONLY_SECTIONS）。
 * 注释行原样保留，方便用户对着传给 llama-server 的文件排查问题。
 */
export function renderPresetForServer(text: string): { text: string; removedSections: string[] } {
  const kept: string[] = [];
  const removedSections: string[] = [];
  let skipping = false;

  for (const line of stripBom(text).split(/\r?\n/)) {
    const section = /^\s*\[(.+?)\]\s*$/.exec(line);
    if (section && section[1]) {
      skipping = LAUNCHER_ONLY_SECTIONS.includes(section[1]);
      if (skipping) {
        if (!removedSections.includes(section[1])) removedSections.push(section[1]);
        continue;
      }
    }
    if (!skipping || line.trim() === "") kept.push(line);
  }

  return { text: kept.join("\n"), removedSections };
}

/** 把 presets 文本写到 ASCII 目录（UTF-8 且不带 BOM，否则 llama-server 解析失败） */
export function stagePresetText(text: string, asciiDir: string, asciiName = "llama-launcher-presets.ini"): string {
  const target = join(asciiDir, asciiName);
  writeFileSync(target, text, "utf8");
  return target;
}

/**
 * `--models-preset` 的路径含非 ASCII 时，先拷到 ASCII 目录再传。
 * 返回真正应该传给 llama-server 的路径。
 */
export function stagePresetIfNonAscii(
  presetPath: string,
  asciiDir: string,
  asciiName = "llama-launcher-presets.ini",
): { argPath: string; copied: boolean } {
  if (!hasNonAsciiPath(presetPath)) return { argPath: presetPath, copied: false };
  const target = join(asciiDir, asciiName);
  copyFileSync(presetPath, target);
  return { argPath: target, copied: true };
}
