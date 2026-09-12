/**
 * `llama-server --help` / `--version` 解析。
 *
 * 为什么必须有这一层：llama.cpp 的参数名和语义随版本漂移，硬编码必然失效。
 * 实测例子（b10488）：
 *   - 草稿模型 KV 量化：`--draft-type-k` 已改名为 `--spec-draft-type-k`
 *   - 草稿模型路径：`--model-draft` 现在是 `--spec-draft-model`
 *   - 生成上限：`--predict` / `--n-predict` 两个名字并存
 *   - `--mlock` 标的 DEPRECATED，改为 `--load-mode`
 *
 * help 的真实排版（实测，解析器就是按它写的）：
 *   `-n,    --predict, --n-predict N         number of tokens to predict (default: -1, ...)`
 *   `                                        (env: LLAMA_ARG_N_PREDICT)`   ← 续行，缩进
 *   `--spec-type none,draft-simple,...`                                  ← 占位符本身就是枚举表
 *   `----- common params -----`                                          ← 分节
 *   `                                        - row: split weight across GPUs`  ← 缩进的列表项，
 *                                                                            不能当选项行
 */

import type { Capabilities, HelpModel, HelpOption } from "./types.ts";

const SECTION_RE = /^-{3,}\s*(.+?)\s*-{3,}$/;
/** 选项行：必须从第 0 列开始；别名用逗号分隔；值占位符与描述之间是 2+ 空格 */
const OPTION_HEADER_RE =
  /^((?:(?:-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]*)\s*,\s*)*(?:-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]*))(\s.*)?$/;
const DEFAULT_RE = /\(default:\s*([^)]*)\)/;
const ENV_RE = /\(env:\s*([A-Za-z0-9_]+)\)/;
const BUILD_RE = /\(build\s+(\d+)/;
const BUILD_SHORT_RE = /\bb(\d{4,})\b/;

/**
 * 从 `--version` 输出里取 build 号。
 * 实测格式：`version: 0.1.2-dev (build 10488, commit 9d77fa172)`
 */
export function readBuildNumber(versionText: string): number | null {
  const byFull = BUILD_RE.exec(versionText);
  if (byFull && byFull[1]) return Number(byFull[1]);
  const byShort = BUILD_SHORT_RE.exec(versionText);
  if (byShort && byShort[1]) return Number(byShort[1]);
  return null;
}

interface RawOption {
  flags: string[];
  valuePlaceholder: string;
  description: string;
  section: string;
}

/** 拆出「值占位符」和「描述」：靠 2+ 空格切，但要区分「单空格紧跟 flag」的情况 */
function splitPlaceholderAndDescription(rest: string): { placeholder: string; description: string } {
  const parts = rest.split(/\s{2,}/);
  if (parts.length === 1) {
    const only = parts[0].trim();
    // 单空格紧跟 flag（如 `--spec-type none,draft-simple,...`）→ 是值占位符，没有描述
    if (rest.startsWith(" ") && !rest.startsWith("  ")) {
      return { placeholder: only, description: "" };
    }
    return { placeholder: "", description: only };
  }
  return {
    placeholder: parts[0].trim(),
    description: parts.slice(1).join(" ").trim(),
  };
}

function parseOptionHeader(
  line: string,
): { flags: string[]; valuePlaceholder: string; description: string } | null {
  const m = OPTION_HEADER_RE.exec(line);
  if (!m || !m[1]) return null;
  const flags = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("-") && s.length > 1);
  if (flags.length === 0) return null;
  const { placeholder, description } = splitPlaceholderAndDescription(m[2] ?? "");
  return { flags, valuePlaceholder: placeholder, description };
}

function finalizeOption(o: RawOption): HelpOption {
  const description = o.description.replace(/\s+/g, " ").trim();
  const defMatch = DEFAULT_RE.exec(description);
  const envMatch = ENV_RE.exec(description);
  const rawDefault = defMatch && defMatch[1] ? defMatch[1].trim() : undefined;
  return {
    flags: o.flags,
    primary: o.flags.find((f) => f.startsWith("--")) ?? o.flags[0],
    valuePlaceholder: o.valuePlaceholder,
    description,
    default: rawDefault ? rawDefault.split(",")[0].trim() : undefined,
    env: envMatch && envMatch[1] ? envMatch[1] : undefined,
    deprecated: /DEPRECATED/i.test(description),
    section: o.section,
  };
}

function parseEnumValues(placeholder: string): string[] | null {
  const stripped = placeholder.replace(/^[[<]/, "").replace(/[\]>]$/, "").trim();
  if (stripped === "") return null;
  if (stripped.includes("|")) {
    const vals = stripped.split("|").map((s) => s.trim()).filter(Boolean);
    return vals.length > 0 ? vals : null;
  }
  // `none,draft-simple,draft-eagle3,...` 这种把枚举表直接写在占位符位置
  if (stripped.includes(",")) {
    const vals = stripped.split(",").map((s) => s.trim()).filter(Boolean);
    return vals.length > 0 ? vals : null;
  }
  return null;
}

export function parseHelp(helpText: string): HelpModel {
  const raw: RawOption[] = [];
  const sections: string[] = [];
  let section = "";
  let current: RawOption | null = null;

  // 容错：help 文本如果是被带 BOM 的工具写进文件的，首行（通常是第一个分节名）
  // 会带上 \ufeff，导致 `----- common params -----` 匹配不上而丢掉整个分节。
  const text = helpText.charCodeAt(0) === 0xfeff ? helpText.slice(1) : helpText;

  for (const line of text.split(/\r?\n/)) {
    const sec = SECTION_RE.exec(line);
    if (sec && sec[1]) {
      section = sec[1];
      if (!sections.includes(section)) sections.push(section);
      current = null;
      continue;
    }

    // 只有第 0 列的行才可能是选项行；缩进行是描述里的项目符号
    if (line.length > 0 && !/^[ \t]/.test(line)) {
      const parsed = parseOptionHeader(line);
      if (parsed) {
        current = {
          flags: parsed.flags,
          valuePlaceholder: parsed.valuePlaceholder,
          description: parsed.description,
          section,
        };
        raw.push(current);
        continue;
      }
    }

    if (current && line.trim() !== "") {
      current.description = `${current.description} ${line.trim()}`.trim();
    }
  }

  const options = raw.map(finalizeOption);
  const byFlag = new Map<string, HelpOption>();
  for (const o of options) {
    for (const f of o.flags) byFlag.set(f, o);
  }
  return { options, byFlag, sections };
}

export function createCapabilities(helpText: string): Capabilities {
  const model = parseHelp(helpText);
  return {
    model,
    raw: helpText,
    has(flag) {
      return model.byFlag.has(flag);
    },
    option(flag) {
      return model.byFlag.get(flag);
    },
    pick(candidates) {
      for (const c of candidates) {
        if (model.byFlag.has(c)) return c;
      }
      return null;
    },
    hasValue(flag) {
      const o = model.byFlag.get(flag);
      return Boolean(o && o.valuePlaceholder !== "");
    },
    enumValues(flag) {
      const o = model.byFlag.get(flag);
      if (!o) return null;
      return parseEnumValues(o.valuePlaceholder);
    },
  };
}

/**
 * 用一份 help 文本造出「假装某些参数不存在」的能力视图，用于测试版本回退分支。
 * （真实场景永远来自运行时探测，这个只在单测里出现。）
 */
export function createCapabilitiesWithout(helpText: string, removedFlags: readonly string[]): Capabilities {
  const caps = createCapabilities(helpText);
  const removed = new Set(removedFlags);
  return {
    ...caps,
    has: (flag) => !removed.has(flag) && caps.has(flag),
    option: (flag) => (removed.has(flag) ? undefined : caps.option(flag)),
    pick: (candidates) => {
      for (const c of candidates) {
        if (!removed.has(c) && caps.has(c)) return c;
      }
      return null;
    },
    hasValue: (flag) => !removed.has(flag) && caps.hasValue(flag),
    enumValues: (flag) => (removed.has(flag) ? null : caps.enumValues(flag)),
  };
}
