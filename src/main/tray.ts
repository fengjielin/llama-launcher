/**
 * 系统托盘常驻。
 *
 * 为什么值得做：这是个"服务启动器"，用户真正想要的状态往往是
 * 「界面关掉、llama-server 继续跑」—— 托盘让这件事变得可见可控：
 * 一眼看出服务在不在跑、随时启停、随时把窗口叫回来。
 *
 * 图标用 base64 内嵌而不是放资源文件：打包时不必处理 asar 内的资源路径，
 * 也不会因为工作目录变化而找不到图标。两个 32×32 的 PNG（约 530 字节）：
 * 灰点 = 没在跑，绿点 = 在跑。
 */

import { Menu, Tray, nativeImage } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import type { AppSettings } from "../shared/ipc.ts";

/** 空闲态图标（灰点） */
const ICON_IDLE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAGvSURBVFhH7VevT8NAFK5EIlGEoFD8DeAQKBSCpISWHw6y3jLc5hbulkwikZOTSP4EJBI5iUSO922Psbbvjmt7CyHwJV+Wtnvv+659ffca/eNXIu5215LM7BWJ8/yX1SBV+jRVZpxm5p1+pxbS9bsrDgkDXuGzIGZlovQL8YBT1Aet+kYS8CUZH3Kq6jhvmwcpaWVm5rFyfSQtfVtMdBSr6f7hyYI4dp3PU4849ffAsysnMLPkm9u7C+LYdb5E3+K0FVxzA2YSXw/XWUYGXIrBxMYGwLbps5QMelZPYiAxhAG8nixVBm6Pq8mEMABetAY7LJkHGo4U8MlQBtBRWTKPs8wcywFzhjKAV5wl83AVIBjMQGZ6LJkHbzZiELhyAz9eA5ed/pYcMGcoA1goS5ZBF63bbhAD1A1ZSgaejxhIDGEAOyxLyeBmNJGCGxugJmdtQsugIhGHkKYG6O76DycUMC4maDIPoLYqDSU8+VaaAx18xRvGqf0xqwfH7uhDLKKW+DKwh7t2SRsTNbgP9q0QK70xH1L1myT2RVzXI69qrwu6rfhO6JUY4jvgjyGKPgDTqK32FfXZ/gAAAABJRU5ErkJggg==";

/** 运行态图标（绿点） */
const ICON_RUNNING_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAGpSURBVFhH7VctU8NAEK3EgQTBhKQIPH8AHBKJyCVIJBLDDA5ZiQSHRCI7Q3MgkUhkZGVl2Ue2JR97Ry65DsPAm3kiaXbfu9xmbzv4x69EME7XhpP0oE7c50dWgyiLT8MseYi0mkU6mUv8/D1TZxziB1gdib5KgkZm6m34FB9xiu6IJupcFGjJUCcjTuUOCr6VkrqS8jw61wet/KKeaPvueL51ebgkrm33y6TauOfU3wN7V08AIvn6/u6SuLbdb7BtcZoKrrcBrXLaig2WkQGXcrAPA7QVz8k1S8mgh8b1oAV9GMDnyVJN4PXYmowXA8RAp3ssWUXRcOQg0JcBdFSWrCLS8YkYwPRmgD5xlqzCVoCgLwOhVlcsWQVejRSw4MoN/HgNBC/pjhjA9GUAC2XJJmzHrh8DKmcpGdgfOdCPAZywLCWDm1EuBfc3oGbGJlSGaQjpa8BpOClmv2qCPvMAastpKMHDtoJ0Yqbe8YVx6vYo6sF8OrYjrbyLeBk4w1FAsoCZtOc3Tq/dBkq0WQypaiqJfVFNMf+1qvauQCdDv6jTy/+AP4bB4AOe8nX0m8qNXQAAAABJRU5ErkJggg==";

/** 托盘要展示的状态 */
export interface TrayState {
  /** 服务状态名（只用于展示与菜单文案，故用 string 而不是 core 的联合类型） */
  serverState: string;
  /** 服务是否在跑（决定"启动/停止"两项菜单的可用性） */
  running: boolean;
  /** 服务地址，写进 tooltip，方便不开窗口也知道端口 */
  baseUrl: string;
  /** 主窗口当前是否可见（决定菜单第一项写"显示"还是"隐藏"） */
  windowVisible: boolean;
}

/** 托盘菜单触发的动作，全部由主进程实现 */
export interface TrayCallbacks {
  /** 显示/隐藏主窗口 */
  onToggleWindow: () => void;
  onStart: () => void;
  onStop: () => void;
  onOpenWebUi: () => void;
  /** 用户在托盘菜单里改了设置（开机自启 / 缩到托盘） */
  onChangeSettings: (patch: Partial<AppSettings>) => void;
  /** 真正退出应用（停服 + 退出） */
  onQuit: () => void;
}

/**
 * 托盘控制器：持有 Tray 实例，按状态刷新图标与右键菜单。
 *
 * 使用方式：构造 → `update()` 跟随服务状态 → 退出时 `destroy()`。
 * 菜单每次都整份重建（Electron 的 `setContextMenu` 语义如此），
 * 所以 `update` 里不做差量比较，实现简单且不会出现"某项该灰却还可点"。
 */
export class TrayController {
  private readonly tray: Tray;
  private readonly callbacks: TrayCallbacks;
  private readonly autostartSupported: boolean;
  private readonly idleIcon;
  private readonly runningIcon;
  private settings: AppSettings;
  private state: TrayState;

  /**
   * @param callbacks 菜单动作回调，见 {@link TrayCallbacks}
   * @param settings 当前应用设置（决定两个复选项的勾选状态）
   * @param initialState 初始状态（通常是 `idle` + 窗口可见）
   * @param autostartSupported 当前平台是否支持开机自启（不支持时该项置灰）
   */
  constructor(
    callbacks: TrayCallbacks,
    settings: AppSettings,
    initialState: TrayState,
    autostartSupported: boolean,
  ) {
    this.callbacks = callbacks;
    this.settings = settings;
    this.state = initialState;
    this.autostartSupported = autostartSupported;
    this.idleIcon = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_IDLE_PNG}`).resize({ width: 16, height: 16 });
    this.runningIcon = nativeImage
      .createFromDataURL(`data:image/png;base64,${ICON_RUNNING_PNG}`)
      .resize({ width: 16, height: 16 });

    this.tray = new Tray(this.state.running ? this.runningIcon : this.idleIcon);
    // 单击切换窗口可见性；双击在 Windows 上会连发两次 click，用同一个开关也无害
    this.tray.on("click", () => this.callbacks.onToggleWindow());
    this.refresh();
  }

  /**
   * 更新状态并刷新图标/菜单/tooltip。
   *
   * @param next 要覆盖的状态字段（未给的字段保持原值）
   */
  update(next: Partial<TrayState>): void {
    this.state = { ...this.state, ...next };
    this.refresh();
  }

  /**
   * 同步应用设置（用户在托盘里改了、或界面里改了，都要让勾选状态跟上）。
   *
   * @param settings 最新的设置
   */
  setSettings(settings: AppSettings): void {
    this.settings = settings;
    this.refresh();
  }

  /** 销毁托盘图标（退出前调用，否则任务栏可能残留图标） */
  destroy(): void {
    this.tray.destroy();
  }

  /** 按当前状态重画图标、tooltip 与右键菜单 */
  private refresh(): void {
    this.tray.setImage(this.state.running ? this.runningIcon : this.idleIcon);

    const lines = [`llama.cpp 启动器 — ${this.state.serverState}`];
    if (this.state.running) lines.push(this.state.baseUrl);
    this.tray.setToolTip(lines.join("\n"));

    const template: MenuItemConstructorOptions[] = [
      {
        label: this.state.windowVisible ? "隐藏主窗口" : "显示主窗口",
        click: () => this.callbacks.onToggleWindow(),
      },
      { type: "separator" },
      { label: "启动服务", enabled: !this.state.running, click: () => this.callbacks.onStart() },
      { label: "停止服务", enabled: this.state.running, click: () => this.callbacks.onStop() },
      { label: "打开网页", enabled: this.state.running, click: () => this.callbacks.onOpenWebUi() },
      { type: "separator" },
      { label: `状态：${this.state.serverState}`, enabled: false },
      { type: "separator" },
      {
        label: "开机自启",
        type: "checkbox",
        checked: this.settings.openAtLogin,
        enabled: this.autostartSupported,
        click: (item) => this.callbacks.onChangeSettings({ openAtLogin: item.checked }),
      },
      {
        label: "关闭窗口时缩到托盘",
        type: "checkbox",
        checked: this.settings.minimizeToTray,
        click: (item) => this.callbacks.onChangeSettings({ minimizeToTray: item.checked }),
      },
      { type: "separator" },
      { label: "退出", click: () => this.callbacks.onQuit() },
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
