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

/**
 * 解析后的 presets.ini。
 *
 * 只做"读"，不做任何写回：传给 llama-server 的那一份由 {@link renderPresetForServer} 另生成。
 */
export interface PresetFile {
  /** 段落名 → 键值（键名统一小写，取原始键名时用 rawKeys） */
  sections: Map<string, Map<string, string>>;
  /** [defaults] 段里的 default-model（注释形式也认） */
  defaultModel: string | null;
  /** 各段出现的键名原始大小写，用于展示 */
  rawKeys: Map<string, string[]>;
}

/** 去掉 UTF-8 BOM：带 BOM 的文件会让 llama-server 直接报解析失败 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 解析 `presets.ini` 文本。
 *
 * 容忍的写法与边界：
 * - 兼容 CRLF / LF，兼容带 BOM 的文件（BOM 会被剥掉）
 * - 键名统一转小写存储；原始大小写另存在 `rawKeys` 里供界面展示
 * - 键值行允许以 `;` 或 `#` 开头 —— `[defaults]` 段就是靠这个约定传递 `default-model`
 * - **段头之前的行会被忽略**（不属于任何段）
 * - `[defaults]` 段只提取 `default-model`，其余键既不进 `sections` 也不参与 preset 占位判断
 * - 解析失败的行静默跳过，不抛异常（配置文件脏一点也应该能启动起来）
 *
 * @param text presets.ini 的完整文本，通常来自 `readFileSync(path, "utf8")`
 * @returns 解析结果，见 {@link PresetFile}；**永不抛异常**
 */
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
 * 语义上更精确的做法是只看当前模型段（{@link presetKeysForModel}），
 * 但默认保持并集以对齐既有行为。
 *
 * `[defaults]` 段被排除在外 —— 它里面的键是启动器自己的约定，不是模型配置。
 *
 * @param file {@link parsePresetsIni} 的结果
 * @returns 去重后的键名数组（均为小写）；没有任何模型段时返回空数组
 */
export function collectPresetKeys(file: PresetFile): string[] {
  const keys = new Set<string>();
  for (const [name, map] of file.sections) {
    if (name === "defaults") continue;
    for (const k of map.keys()) keys.add(k);
  }
  return [...keys];
}

/**
 * 只看指定模型段定义过的键（更精确的 preset 占位判断，当前未作为默认策略）。
 *
 * @param file {@link parsePresetsIni} 的结果
 * @param modelId 模型名（GGUF 文件名去掉 .gguf），大小写敏感，与段名精确匹配
 * @returns 该段定义过的键名数组；段不存在时返回空数组（不抛异常）
 */
export function presetKeysForModel(file: PresetFile, modelId: string): string[] {
  const map = file.sections.get(modelId);
  return map ? [...map.keys()] : [];
}

/**
 * 取某个模型段里数值型配置的值（典型用途：读该模型的 `ctx-size`）。
 *
 * 边界：段不存在、键不存在、或值不是十进制整数时一律返回 `null`，
 * 让调用方用「读不到 → 走兜底值」的方式处理，而不是拿到 `NaN` 继续算下去。
 *
 * @param file {@link parsePresetsIni} 的结果
 * @param modelId 模型名（段名）
 * @param key 键名，大小写不敏感（内部会转小写后查找）
 * @returns 解析出的整数；无该键或值非整数时返回 `null`
 */
export function getNumericPresetValue(file: PresetFile, modelId: string, key: string): number | null {
  const map = file.sections.get(modelId);
  if (!map) return null;
  const raw = map.get(key.toLowerCase());
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 判断路径里是否含非 ASCII 字符（中文、全角符号等）。
 *
 * 存在这个检查是因为实测：`--models-preset` 传非 ASCII 路径时，
 * llama-server 会刷两行日志后立刻崩退，而不是给出可读的报错。
 *
 * 判定范围是 `\x20-\x7e` 之外的所有字符，因此空格与常见符号都算 ASCII。
 *
 * @param path 待检查的路径（Windows 反斜杠路径同样适用）
 * @returns 含非 ASCII 字符返回 `true`
 */
export function hasNonAsciiPath(path: string): boolean {
  return /[^\x20-\x7e]/.test(path);
}

/**
 * 生成「只含模型段」的 presets 文本：剔除启动器自用的段（见 {@link LAUNCHER_ONLY_SECTIONS}）。
 *
 * 为什么需要单独生成一份：`[defaults]` 段是启动器的约定，但 llama-server 会把它当成
 * 一个名叫 `defaults` 的模型列进「可用模型」，于是网页下拉框里多出一个假模型。
 * 读配置仍从原文件读，只有**递给 llama-server 的那一份**被裁剪。
 *
 * 边界：注释行、空行、模型段一律原样保留（方便用户对着传给 llama-server 的文件排查问题）；
 * 被剔除的段连同它的内容一起跳过；段头大小写敏感（与 llama-server 一致）。
 *
 * @param text presets.ini 的原始文本
 * @returns `text` 为裁剪后的文本（行尾统一为 `\n`），`removedSections` 为被剔除的段名（去重）
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

/**
 * 把 presets 文本写到指定目录，返回写出的路径。
 *
 * 必须用 Node 的 `utf8` 写入（不带 BOM）—— 带 BOM 会让 llama-server 解析失败。
 *
 * @param text 要写入的内容，通常来自 {@link renderPresetForServer}
 * @param asciiDir 目标目录，应当是纯 ASCII 路径
 * @param asciiName 文件名，默认 `llama-launcher-presets.ini`
 * @returns 写出的完整路径
 * @throws {Error} 目录不存在或没有写权限时，由 `writeFileSync` 抛出（如 `ENOENT` / `EPERM`）
 */
export function stagePresetText(text: string, asciiDir: string, asciiName = "llama-launcher-presets.ini"): string {
  const target = join(asciiDir, asciiName);
  writeFileSync(target, text, "utf8");
  return target;
}

/**
 * `--models-preset` 的路径含非 ASCII 时，先原样拷到 ASCII 目录再传。
 *
 * 这是 {@link renderPresetForServer} 出现之前的兜底方案（不裁剪内容，只搬家）；
 * 当前主流程用的是「裁剪 + 写入」，但保留此函数用于只需要搬家的场合。
 *
 * @param presetPath 配置里的 presets.ini 路径
 * @param asciiDir 目标目录，应当是纯 ASCII 路径
 * @param asciiName 目标文件名，默认 `llama-launcher-presets.ini`
 * @returns `argPath` 为最终应传给 llama-server 的路径，`copied` 表示是否真的做了拷贝
 * @throws {Error} 需要拷贝但源文件不存在或目标不可写时，由 `copyFileSync` 抛出
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
