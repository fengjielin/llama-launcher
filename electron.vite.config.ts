import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const r = (relPath: string): string => fileURLToPath(new URL(relPath, import.meta.url));

/**
 * 三端分别构建：
 *   main     —— ESM（Electron 44 支持 ESM 主进程）
 *   preload  —— CJS，文件名固定 .cjs（package.json 是 type: module，.js 会被当成 ESM 而 preload 需要 CJS）
 *   renderer —— React + Tailwind
 *
 * ⚠ `electron` 必须显式列入 external：
 *   electron-vite 的 externalizeDepsPlugin 只外部化 package.json 的 dependencies，
 *   而 electron 装在 devDependencies 里。不外部化的话，rollup 会把 electron 这个 **npm 包**
 *   整个打进 bundle —— 那个包的 index.js 在 load 时会去解析自己的二进制路径，找不到就现场下载，
 *   结果就是应用一启动就报 "Electron failed to install correctly"。
 *   （本地实测踩过：out/main/index.js 里出现了 electron/dist/resources/default_app.asar 的调用栈。）
 *
 * core（src/core）不打进渲染层：界面只能通过 IPC 拿到数据，保证「界面不改命令行」。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      lib: { entry: r("src/main/index.ts") },
      rollupOptions: {
        external: ["electron"],
        output: { format: "es", entryFileNames: "index.js" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      lib: { entry: r("src/preload/index.ts") },
      rollupOptions: {
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: r("src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: r("out/renderer"),
      emptyOutDir: true,
      rollupOptions: { input: r("src/renderer/index.html") },
    },
  },
});
