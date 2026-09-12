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
 *
 * 实测格式：`version: 0.1.2-dev (build 10488, commit 9d77fa172)`。
 * 先按完整格式 `(build NNNN)` 匹配；匹配不到再退而找形如 `b10679` 的短写法
 * （有些构建的版本行里只有这个）。
 *
 * @param versionText `llama-server --version` 的完整输出（stdout 与 stderr 拼接即可）
 * @returns build 号；两种格式都匹配不到时返回 `null`（调用方应据此放弃版本相关的判断）
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

/** 解析过程中的中间结构：`finalizeOption` 之前的一条选项，字段都还是"生"的 */
interface RawOption {
  flags: string[];
  valuePlaceholder: string;
  description: string;
  section: string;
}

/**
 * 拆出「值占位符」和「描述」。
 *
 * 难点在于 help 用**空格数量**同时表达了两件事：别名之间用逗号加少量空格分隔，
 * 而"选项头"与"描述"之间固定用 2 个以上空格。所以不能简单按空格切：
 *
 * - `-c,    --ctx-size N                     size of...` → 2+ 空格在 `N` 之后
 *   → 占位符 `N`，描述 `size of...`
 * - `--spec-type none,draft-simple,...`（行尾没有描述，flag 与枚举表之间**只有 1 个空格**）
 *   → 整体是占位符，描述为空
 * - `-cl,   --cache-list                     show list...`（没有占位符，紧跟一长串空格）
 *   → 拆出的第一段是空串，占位符为空，描述正常
 *
 * @param rest 已经去掉选项名（flags）之后的剩余部分
 * @returns `placeholder` 为值占位符（无值则为空串），`description` 为描述文本
 */
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

/**
 * 解析一行 help，判断它是不是**选项行**，是则拆出别名、值占位符与描述。
 *
 * 调用方已保证传入的行从第 0 列开始（缩进行是描述里的项目符号，不是选项）。
 * 别名按逗号切分后再过滤，因此 `- row: ...` 这类内容即使漏进来也会因
 * 不以 `-` 开头而被丢弃 → 返回 `null`。
 *
 * @param line 一行原始 help 文本（第 0 列开始的）
 * @returns 解析结果；不是选项行、或一个合法别名都没有时返回 `null`
 */
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

/**
 * 把中间结构补全成对外的 {@link HelpOption}。
 *
 * 这里做四件事：
 * 1. 把跨行的描述压成单行（help 里的续行已由 `parseHelp` 拼进 description）；
 * 2. 从 `(default: x)` 里取默认值，且**只取第一个逗号之前**的部分 ——
 *    因为 llma.cpp 常写成 `(default: 0, 0 = loaded from model)`，整段当默认值是没用的；
 * 3. 从 `(env: LLAMA_ARG_X)` 里取环境变量名；
 * 4. 依描述里有没有 `DEPRECATED` 打标（如 b10488 的 `--mlock`）。
 *
 * `primary` 取第一个长选项，取不到才退回短选项 —— 用于界面展示，
 * 因为长选项可读性更好（如 `--n-predict` 而不是 `-n`）。
 *
 * @param o 解析出的中间结构
 * @returns 补全后的选项；`default` / `env` 抽不到时为 `undefined`
 */
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

/**
 * 从值占位符里解析枚举候选。
 *
 * 两种排版都要认：
 * - 方括号/尖括号里的 `|` 列表：`[on|off|auto]`、`<0|1>`
 * - 直接把枚举表写在占位符位置的逗号列表：`none,draft-simple,draft-eagle3,...`
 *
 * 注意第二种里的 `...` 只是 help 的省略写法，会被原样当作一个候选值返回 ——
 * 界面展示无伤大雅，但不要拿它去校验用户输入。
 *
 * @param placeholder 选项的值占位符原文
 * @returns 解析出的候选值数组；不是枚举（如 `N`、`FNAME`）或解析为空时返回 `null`
 */
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

/**
 * 解析 `llama-server --help` 的完整输出。
 *
 * 逐行状态机：遇到分节行切分节，遇到第 0 列且能解析成选项头的行开一条新选项，
 * 其余非空行一律当作**上一条选项的续行**（help 里描述会缩进换行，例如 `(env: ...)`）。
 *
 * 边界与容错：
 * - 首字符是 UTF-8 BOM 时先剥掉，否则第一行 `----- common params -----` 匹配不上、
 *   整个分节会丢失（实测踩过：用带 BOM 写出的 help 文件）
 * - **缩进行一律不当选项**（描述里的 `- row: ...` 项目符号就是靠这条排除的）
 * - 选项出现之前的内容被忽略（此时还没有 current）
 * - 分节名去重后按出现顺序返回
 * - 永不抛异常；无法解析的内容被静默跳过，最坏结果是选项偏少
 *
 * @param helpText `llama-server --help` 的完整输出（stdout 与 stderr 拼接即可）
 * @returns 解析结果，见 {@link HelpModel}；文本为空时返回空模型而不是 `null`
 */
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

/**
 * 把 help 文本包装成"当前版本支持什么"的能力视图。
 *
 * 这是整个参数拼装的地基：`buildArgs` 只通过这里返回的 `pick()` 决定用哪个参数名，
 * 因此版本改名（`--draft-type-k` → `--spec-draft-type-k`）不需要改任何拼装代码。
 *
 * @param helpText `llama-server --help` 的完整输出
 * @returns 能力视图；文本为空时各项查询都会返回"不支持"，不会抛异常
 */
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
 * 用一份 help 文本造出「假装某些参数不存在」的能力视图，专门用于测试版本回退分支。
 *
 * 真实场景的能力视图永远来自运行时探测（{@link createCapabilities}），
 * 这个只在单测里出现 —— 否则没法验证"参数被改名/删除时拼装逻辑会不会正确回退"。
 *
 * @param helpText 作为基准的 help 文本，通常是新版本文本
 * @param removedFlags 要伪装成"不存在"的参数名（别名要逐个列出，如 `["--fit-target", "-fitt"]`）
 * @returns 屏蔽掉指定参数后的能力视图
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
