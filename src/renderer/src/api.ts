import type { LlamaApi } from "../../shared/ipc.ts";

/**
 * 渲染层拿到 preload 注入的 API。
 * 拿不到（例如用浏览器直接打开了构建产物）就返回 null，界面会给出明确提示，
 * 而不是抛一个看不懂的 TypeError。
 */
export function getApi(): LlamaApi | null {
  if (typeof window === "undefined") return null;
  return window.llamaApi ?? null;
}
