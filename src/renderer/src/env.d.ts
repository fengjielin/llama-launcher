/// <reference types="vite/client" />

import type { LlamaApi } from "../../shared/ipc.ts";

declare global {
  interface Window {
    /** 由 preload 注入；在浏览器里直接打开时会缺失 */
    llamaApi?: LlamaApi;
  }
}
