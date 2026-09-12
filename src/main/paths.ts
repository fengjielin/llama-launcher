/**
 * 数据目录的选择策略（便携优先）。
 *
 * 一个 Electron 应用必然会有一个 userData 目录（Chromium 的缓存、Local Storage 等），
 * 默认在 `%APPDATA%\<应用名>`。启动器自己的配置文件、设置、档案也一并放在那里的话，
 * 就变成"绿色的 exe + 散落一地的 AppData"，拷走整个文件夹并不能带走配置 —— 与便携的初衷相反。
 *
 * 所以策略是：**打包后优先把一切都放在 exe 同目录**，只有在那个目录不可写时才退回 userData
 * （典型场景：NSIS 装到 `C:\Program Files\...`，普通权限下不可写）。
 * 开发模式（未打包）不参与这套逻辑，配置就用项目目录。
 */

import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** 便携模式下 Chromium 运行时数据放哪个子目录（与 exe 同级，避免把应用目录弄乱） */
export const PORTABLE_DATA_SUBDIR = "data";

/** 启动器在便携模式下使用的配置文件名（直接放 exe 同级，方便手改） */
export const PORTABLE_CONFIG_NAME = "llama-launcher.json";

/**
 * 探测某个目录是否可写。
 *
 * 做法是实际写一个探针文件再删掉 —— 只看权限位在 Windows 上并不可靠
 * （ACL、只读介质、网络盘的表现都不一样）。探针文件名固定，失败即视为不可写。
 *
 * @param dir 目标目录
 * @returns 能创建并删除文件返回 `true`；目录不存在或无权限返回 `false`
 */
export function isDirWritable(dir: string): boolean {
  const probe = join(dir, ".llama-launcher-write-probe");
  let fd: number | null = null;
  try {
    fd = openSync(probe, "w");
    writeSync(fd, "probe");
    closeSync(fd);
    fd = null;
    unlinkSync(probe);
    return true;
  } catch {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 忽略
      }
    }
    try {
      unlinkSync(probe);
    } catch {
      // 探针可能压根没建出来
    }
    return false;
  }
}

/** 数据与配置的落点 */
export interface DataLayout {
  /** 是否采用了"便携模式"（一切放 exe 同目录） */
  portable: boolean;
  /** 配置文件路径 */
  configPath: string;
  /** Chromium userData 目录（缓存、Local Storage 等放这里） */
  dataDir: string;
}

/** {@link chooseDataLayout} 的入参；`canWrite` 可注入，便于单测覆盖只读场景 */
export interface ChooseDataLayoutInput {
  /** 是否已打包（开发模式走另一套） */
  isPackaged: boolean;
  /** exe 所在目录（打包后才有意义） */
  exeDir: string;
  /** 未打包时的项目根目录 */
  projectDir: string;
  /**
   * 取 Electron 默认的 userData 目录。
   *
   * ⚠ 必须是**惰性**的（传函数而不是字符串）：`app.getPath("userData")` 这个调用本身
   * 会把目录建出来（实测确认），而便携模式下我们根本不想要那个目录 ——
   * 一旦在决定之前就调用它，`%APPDATA%\<应用名>` 就会留下一个空目录。
   */
  defaultUserDataDir: () => string;
  /** 目录可写性探测；默认 {@link isDirWritable} */
  canWrite?: (dir: string) => boolean;
}

/**
 * 决定配置与数据放哪里。
 *
 * 决策顺序：
 * 1. **开发模式**：配置放项目根目录，userData 用 Electron 默认值（不去动它，免得把项目目录搞脏）
 * 2. **打包后且 exe 目录可写**：便携模式 —— 配置放 exe 同级，运行时数据放 `<exeDir>/data`
 * 3. **打包后但 exe 目录只读**：退回 userData（否则应用连缓存都写不了，直接起不来）
 *
 * @param input 打包状态、exe 目录、项目目录、默认 userData 目录（惰性）与可注入的可写性探测
 * @returns 落点方案，见 {@link DataLayout}
 */
export function chooseDataLayout(input: ChooseDataLayoutInput): DataLayout {
  const canWrite = input.canWrite ?? isDirWritable;

  if (!input.isPackaged) {
    return {
      portable: false,
      configPath: join(input.projectDir, PORTABLE_CONFIG_NAME),
      dataDir: input.defaultUserDataDir(),
    };
  }

  if (canWrite(input.exeDir)) {
    return {
      portable: true,
      configPath: join(input.exeDir, PORTABLE_CONFIG_NAME),
      dataDir: join(input.exeDir, PORTABLE_DATA_SUBDIR),
    };
  }

  const fallback = input.defaultUserDataDir();
  return {
    portable: false,
    configPath: join(fallback, PORTABLE_CONFIG_NAME),
    dataDir: fallback,
  };
}
