/**
 * 应用级设置的读写（启动器自己的偏好，不是 llama-server 的启动配置）。
 *
 * 落盘位置由主进程给（`app.getPath("userData")` 下）—— 打包后安装目录只读，
 * 而这份文件需要随时可写。文件读写都容错：读坏了退回默认值，
 * 免得一个坏掉的小 JSON 让整个界面起不来。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSettings } from "../shared/ipc.ts";

/** 设置文件名（放在 Electron 的 userData 目录下） */
export const SETTINGS_FILE = "llama-launcher-settings.json";

/**
 * 默认设置。
 *
 * `minimizeToTray` 默认 **true**：这个程序的一半价值是"后台常驻并把服务跑着"，
 * 关掉窗口就停服会让人措手不及；托盘菜单里可以改，界面底部也有提示。
 */
export const DEFAULT_SETTINGS: AppSettings = {
  openAtLogin: false,
  minimizeToTray: true,
};

/**
 * 由 userData 目录推出设置文件路径。
 *
 * @param userDataDir `app.getPath("userData")` 的值
 * @returns 设置文件的完整路径
 */
export function settingsPathFor(userDataDir: string): string {
  return join(userDataDir, SETTINGS_FILE);
}

/**
 * 把任意来源的对象归一化成 {@link AppSettings}（不认识的值一律退回默认）。
 *
 * @param raw 已 `JSON.parse` 的值，或任何未知内容
 * @returns 两项都是布尔值的设置对象
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const source: Record<string, unknown> = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    openAtLogin: typeof source["openAtLogin"] === "boolean" ? source["openAtLogin"] : DEFAULT_SETTINGS.openAtLogin,
    minimizeToTray:
      typeof source["minimizeToTray"] === "boolean" ? source["minimizeToTray"] : DEFAULT_SETTINGS.minimizeToTray,
  };
}

/**
 * 读设置文件。
 *
 * **永不抛异常**：文件不存在、内容坏了、无权限，都退回默认值 ——
 * 设置读不出来不该阻止程序启动。
 *
 * @param path 设置文件路径
 * @returns 归一化后的设置
 */
export function loadSettings(path: string): AppSettings {
  try {
    if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 写设置文件（UTF-8、不带 BOM）。
 *
 * @param path 设置文件路径
 * @param settings 要保存的设置
 * @throws {Error} 目录不存在或不可写时由 `writeFileSync` 抛出 —— 这是需要让用户知道的失败
 *   （否则界面上改了开关却每次重启都失效，很难排查）
 */
export function saveSettings(path: string, settings: AppSettings): void {
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
