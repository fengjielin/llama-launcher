/**
 * 「点窗口 ✕ 时该怎么办」的决策。
 *
 * 单独抽成纯函数的原因：这是全应用最容易误伤用户的一处 —— 判错一次，要么正在跑的模型被
 * 悄悄停掉，要么用户以为关了程序、进程却还在后台。把决策与副作用（弹框、隐藏窗口、退出）
 * 分开，就能用单测把每种组合钉住，而主进程那边只剩几行胶水。
 */

/** 关闭窗口时要执行的动作 */
export type CloseAction =
  /** 放行关闭：窗口真的关掉（随后 `window-all-closed` → `app.quit()`，退出前会先停服） */
  | "close"
  /** 拦下并隐藏窗口：应用与 llama-server 继续在后台跑 */
  | "hide-to-tray"
  /** 拦下并问用户一次：服务还在跑，让他选"退出并停止"还是"缩到托盘" */
  | "ask";

/** {@link decideCloseAction} 的入参 */
export interface CloseDecisionInput {
  /** 设置里的「关闭窗口时缩到托盘」 */
  minimizeToTray: boolean;
  /** 是否已经在退出流程里（`before-quit` 拦过一次之后又收到的 close 事件） */
  quitting: boolean;
  /** llama-server 是否还活着（启动中 / 运行中 / 停止中都算） */
  serverActive: boolean;
}

/**
 * 决定关闭窗口时的动作。
 *
 * 规则（顺序有意义）：
 * 1. **已在退出流程中** → `close`：这时再拦一次就永远退不掉了
 * 2. **用户显式开了「缩到托盘」** → `hide-to-tray`：这正是这个开关的语义，不必再问
 * 3. **服务没跑** → `close`：没有需要保护的东西，点 ✕ 就该退出（这是大多数人的直觉）
 * 4. **服务在跑** → `ask`：只有这种情况下才值得打断用户 —— 直接退会卸载模型，
 *    直接缩托盘又违背他刚才点 ✕ 的意图
 *
 * @param input 设置项、退出状态与服务是否活着
 * @returns 见 {@link CloseAction}
 */
export function decideCloseAction(input: CloseDecisionInput): CloseAction {
  if (input.quitting) return "close";
  if (input.minimizeToTray) return "hide-to-tray";
  if (!input.serverActive) return "close";
  return "ask";
}
