/**
 * 多套配置档案（profile）管理。
 *
 * 形态：**一个档案 = 目录下的一个 JSON 文件**，内容就是一份完整的 {@link LauncherConfig}。
 * 选择这种最朴素的形式而不是"一个大 JSON 装所有档案"，是因为：
 * 用户可以直接用编辑器改、可以直接拷给别人、坏了也只坏一套。
 *
 * 目录不存在时自动创建（`listProfiles` 则把"目录不存在"当作"还没有档案"）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { normalizeConfig, saveConfigFile } from "./config.ts";
import type { LauncherConfig } from "./types.ts";

/** 档案文件扩展名 */
export const PROFILE_EXT = ".json";

/** 档案列表里展示的摘要信息（避免为了列表而把整份配置读进界面） */
export interface ProfileSummary {
  /** `single` 或 `router` */
  mode: string;
  /** 一眼能认出是哪个模型：router 模式取预加载模型或目录名，single 模式取主模型文件名 */
  model: string;
  port: number | null;
  context: number | null;
}

/** 一个档案的描述 */
export interface ProfileInfo {
  /** 档案名（不含扩展名），可用于 {@link profilePath} 反查 */
  name: string;
  /** 档案文件绝对路径 */
  path: string;
  /** 文件最后修改时间（毫秒），界面上按它排序 */
  mtimeMs: number;
  summary: ProfileSummary;
  /** 文件能读且能解析；`false` 时 `summary` 里是占位说明 */
  valid: boolean;
}

const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const MAX_NAME_LENGTH = 60;

/**
 * 把用户输入的档案名规整成安全的文件名。
 *
 * 处理内容（**顺序有意义**）：
 * - 去掉 Windows 非法字符（`<>:"/\|?*` 与控制字符，含路径分隔符 → 从根上杜绝目录穿越）
 *   注意控制字符先于空白折叠被替换，因此名称里的制表符/换行会变成 `_` 而不是空格
 * - 折叠连续空白、去掉首尾空白
 * - 去掉首尾的点（Windows 不允许文件名以点结尾，`.` / `..` 也会变成空）
 * - 超长截断到 {@link MAX_NAME_LENGTH}
 * - 规整后为空则回退成 `默认档案`
 *
 * @param raw 用户输入的原始名称
 * @returns 可直接用作文件名的安全名称（不含扩展名）
 */
export function sanitizeProfileName(raw: string): string {
  const cleaned = raw
    .replace(ILLEGAL_NAME_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return cleaned === "" ? "默认档案" : cleaned;
}

/**
 * 由档案名推出档案文件路径。
 *
 * 名称会先经 {@link sanitizeProfileName} 规整，因此传入 `../../evil` 也只会得到
 * 目录内的一个普通文件（不会逃出 `dir`）。
 *
 * @param dir 档案目录
 * @param name 档案名（不必是安全名称）
 * @returns 档案文件的完整路径
 */
export function profilePath(dir: string, name: string): string {
  return join(dir, `${sanitizeProfileName(name)}${PROFILE_EXT}`);
}

/**
 * 从配置里抽出用于列表展示的摘要。
 *
 * @param config 启动配置
 * @returns 模式、模型标识、端口与上下文长度
 */
export function summarizeConfig(config: LauncherConfig): ProfileSummary {
  const mode = config.mode === "router" ? "router" : "single";
  let model = "";
  if (mode === "router") {
    if (typeof config.preload_model === "string" && config.preload_model !== "") {
      model = config.preload_model;
    } else if (typeof config.models_dir === "string" && config.models_dir !== "") {
      model = `${basename(config.models_dir)}（目录）`;
    }
  } else if (typeof config.main_model === "string" && config.main_model !== "") {
    model = basename(config.main_model);
  }

  return {
    mode,
    model: model === "" ? "（未指定模型）" : model,
    port: typeof config.port === "number" ? config.port : null,
    context: typeof config.context === "number" ? config.context : null,
  };
}

/**
 * 列出目录下的全部档案，按最后修改时间**从新到旧**排序。
 *
 * 边界：目录不存在时返回空数组（首次使用的正常情况，不抛异常）；
 * 单个文件解析失败不影响其它档案 —— 该条会以 `valid: false` 出现，
 * 界面可以提示"这一套坏了"而不是整个列表消失。
 *
 * @param dir 档案目录
 * @returns 档案描述数组；目录为空或不存在时返回空数组
 */
export function listProfiles(dir: string): ProfileInfo[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(PROFILE_EXT));
  const profiles: ProfileInfo[] = [];

  for (const file of files) {
    const path = join(dir, file);
    const name = file.slice(0, -PROFILE_EXT.length);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // 读不到时间戳就按 0 排到最后，不影响其余功能
    }

    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      const { config } = normalizeConfig(raw);
      profiles.push({ name, path, mtimeMs, summary: summarizeConfig(config), valid: true });
    } catch {
      profiles.push({
        name,
        path,
        mtimeMs,
        summary: { mode: "?", model: "（配置无法解析）", port: null, context: null },
        valid: false,
      });
    }
  }

  return profiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 读一个档案并归一化。
 *
 * @param path 档案文件路径
 * @returns 归一化后的配置与告警
 * @throws {Error} 文件读不到或 JSON 非法时抛出（由 `readFileSync` / `JSON.parse` 抛出）
 */
export function readProfile(path: string): { config: LauncherConfig; warnings: string[] } {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return normalizeConfig(raw);
}

/**
 * 保存一个档案（先归一化再写盘，目录不存在会自动创建）。
 *
 * @param dir 档案目录
 * @param name 档案名（会被规整成安全文件名）
 * @param config 要保存的配置
 * @returns 保存后的档案描述（含路径与摘要）
 * @throws {Error} 目录建不出来或文件不可写时抛出（由 `mkdirSync` / `writeFileSync` 抛出）
 */
export function saveProfile(dir: string, name: string, config: LauncherConfig): ProfileInfo {
  mkdirSync(dir, { recursive: true });
  const path = profilePath(dir, name);
  const { config: normalized } = normalizeConfig(config);
  saveConfigFile(path, normalized);
  return {
    name: sanitizeProfileName(name),
    path,
    mtimeMs: Date.now(),
    summary: summarizeConfig(normalized),
    valid: true,
  };
}

/**
 * 删除一个档案。
 *
 * 幂等：文件已不存在时也视为成功（不抛异常），避免用户连点两次就报错。
 *
 * @param dir 档案目录
 * @param name 档案名（会被规整）
 * @throws {Error} 文件存在但删不掉（被占用/无权限）时抛出
 */
export function deleteProfile(dir: string, name: string): void {
  const path = profilePath(dir, name);
  if (!existsSync(path)) return;
  rmSync(path, { force: true });
}
