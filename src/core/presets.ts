/**
 * 模型预设（llama-server 的 `--models-preset`）。
 *
 * ## 现在以 JSON 为准
 *
 * 预设**直接写在配置文件的 `presets` 字段里**（`{ "模型名": { "ctx-size": 16384, ... } }`），
 * 启动时由 {@link renderPresetFile} 渲染成 llama-server 认的 ini、写到一个临时文件再传路径。
 * 也就是说 ini 只是"给服务器看的中间产物"，用户不再需要维护它 —— 它只作为**一次性导入来源**
 * （{@link presetsJsonFromPresetFile} + {@link parsePresetsIni}）。
 *
 * 这么做顺带消掉了 ini 时代的两个麻烦：
 *   1. `--models-preset` 传非 ASCII 路径会让 llama-server 刷两行日志后崩退 —— 现在路径由我们
 *      自己生成在 `%TEMP%`，不可能带中文；
 *   2. `[defaults]` 段会被服务器当成一个名叫 defaults 的假模型 —— 现在这份 ini 由我们生成，
 *      根本不会写出这样的段。
 *
 * ## 仍然成立的 llama.cpp 规则（渲染与导入都要遵守）
 *
 *   · 段名 = 模型名（GGUF 文件名去掉 `.gguf`），`[*]` 通配段不被支持；
 *   · ini 必须 UTF-8 且**不带 BOM**，否则服务器报 "failed to parse server config file"；
 *   · 同一个键 preset 与命令行都给时，命令行优先（实测），所以 preset 里定义过的键命令行不能再传。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 解析后的 presets.ini 的内存形态。
 *
 * 只做"读"：传给 llama-server 的那一份由 {@link renderPresetFile} 从 JSON 现渲染。
 */
export interface PresetFile {
  /** 段落名 → 键值（键名统一小写，取原始键名时用 rawKeys） */
  sections: Map<string, Map<string, string>>;
  /** [defaults] 段里的 default-model（注释形式也认）；对应配置里的 `preload_model` */
  defaultModel: string | null;
  /** 各段出现的键名原始大小写，用于展示 */
  rawKeys: Map<string, string[]>;
}

/** 模型预设的 JSON 形态：模型名 → 参数表（键名沿用 llama.cpp 的预设键） */
export type PresetJson = Record<string, Record<string, string | number | boolean>>;

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
 * 把配置里的 JSON 预设转成内存形态（{@link PresetFile}），供接管判断与渲染复用。
 *
 * 值一律按"写什么就传什么"处理（`String(value)`）：布尔写成 `true` / `false`，
 * 数字保持字面量。这样 llama.cpp 将来新增预设键，本启动器不需要跟着改代码。
 *
 * @param presets 配置里的 `presets` 字段：模型名 → 参数表
 * @param defaultModel 预加载模型名，会作为 `defaultModel` 带进结果（对应旧 ini 的 default-model）
 * @returns 内存形态；`sections` 的键名小写化，`rawKeys` 保留用户写的原始大小写
 */
export function presetFileFromJson(presets: PresetJson, defaultModel: string | null = null): PresetFile {
  const sections = new Map<string, Map<string, string>>();
  const rawKeys = new Map<string, string[]>();
  for (const [model, params] of Object.entries(presets)) {
    const map = new Map<string, string>();
    const raw: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      map.set(key.toLowerCase(), String(value));
      raw.push(key);
    }
    sections.set(model, map);
    rawKeys.set(model, raw);
  }
  return { sections, defaultModel, rawKeys };
}

/**
 * 把解析好的 ini 转成 JSON 预设（一次性导入用）。
 *
 * `[defaults]` 段不进结果：它里面只有启动器自用的 `default-model` 约定，
 * 对应配置里的 `preload_model`，不该出现在模型参数表里。
 *
 * @param file {@link parsePresetsIni} 的结果
 * @returns 模型名 → 参数表；键名用 ini 里的原始大小写
 */
export function presetsJsonFromPresetFile(file: PresetFile): PresetJson {
  const out: PresetJson = {};
  for (const [model, params] of file.sections) {
    if (model === "defaults") continue;
    const table: Record<string, string | number> = {};
    const raws = file.rawKeys.get(model) ?? [];
    for (const [lowerKey, value] of params) {
      // 尽量按原始大小写还原键名（rawKeys 与 sections 顺序一致）
      const rawKey = raws.find((k) => k.toLowerCase() === lowerKey) ?? lowerKey;
      // 纯十进制整数在 JSON 里写成数字更好读；其余（q4_0 / mmap+mlock 等）保持字符串
      table[rawKey] = /^-?\d+$/.test(value) ? Number(value) : value;
    }
    out[model] = table;
  }
  return out;
}

/**
 * 把内存形态渲染成 llama-server 认的 ini 文本。
 *
 * 输出特点：
 * - 段名即模型名，段内一行一个 `键 = 值`；
 * - **不会**写出 `[defaults]` 这类启动器自用段（那份 ini 是我们生成的，不需要再剔除）；
 * - 行尾统一 `\n`，由 {@link stagePresetText} 以 UTF-8 无 BOM 写入 —— 带 BOM 会让服务器解析失败；
 * - 空参数表的模型段会被跳过（写一个空段没有意义，还可能被服务器当成模型占位）。
 *
 * @param file 内存形态的预设
 * @returns ini 文本；没有任何有效模型段时返回空串
 */
export function renderPresetFile(file: PresetFile): string {
  const blocks: string[] = [];
  for (const [model, params] of file.sections) {
    if (model === "defaults" || params.size === 0) continue;
    const raws = file.rawKeys.get(model) ?? [];
    const lines = [`[${model}]`];
    for (const [lowerKey, value] of params) {
      const rawKey = raws.find((k) => k.toLowerCase() === lowerKey) ?? lowerKey;
      lines.push(`${rawKey} = ${value}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

/**
 * 把导入来的预设并进现有预设表。
 *
 * 冲突策略：**同名模型一律保留现有的**，不覆盖 —— 导入是"补充"，不该把用户已经在 JSON 里
 * 调过的模型悄悄改掉；冲突的模型名会如实报出来，让他自己决定。
 *
 * @param existing 配置里现有的 `presets`
 * @param imported 从 ini 导入的结果
 * @returns `presets` 为合并结果（新对象，不改入参）；`added` 为新增的模型名；`skipped` 为因同名跳过的
 */
export function mergePresets(
  existing: PresetJson,
  imported: PresetJson,
): { presets: PresetJson; added: string[]; skipped: string[] } {
  const merged: PresetJson = { ...existing };
  const added: string[] = [];
  const skipped: string[] = [];
  for (const [model, params] of Object.entries(imported)) {
    if (Object.prototype.hasOwnProperty.call(merged, model)) {
      skipped.push(model);
      continue;
    }
    merged[model] = params;
    added.push(model);
  }
  return { presets: merged, added, skipped };
}

/**
 * 把 presets 文本写到指定目录，返回写出的路径。
 *
 * 必须用 Node 的 `utf8` 写入（不带 BOM）—— 带 BOM 会让 llama-server 解析失败。
 *
 * @param text 要写入的内容，通常来自 {@link renderPresetFile}
 * @param dir 目标目录（现在是 %TEMP%，由我们自己生成，所以必然是 ASCII 路径）
 * @param name 文件名，默认 `llama-launcher-presets.ini`
 * @returns 写出的完整路径
 * @throws {Error} 目录不存在或没有写权限时，由 `writeFileSync` 抛出（如 `ENOENT` / `EPERM`）
 */
export function stagePresetText(text: string, dir: string, name = "llama-launcher-presets.ini"): string {
  const target = join(dir, name);
  writeFileSync(target, text, "utf8");
  return target;
}
