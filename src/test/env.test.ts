/**
 * 真机环境测试（默认套件不跑）。
 *
 * 这些用例要读本机的 llama.cpp 安装与模型文件，换台机器/换构建就可能失败或跳过，
 * 所以从 `pnpm test` 里拆出来，单独用 `pnpm test:env` 跑。
 *
 * 约定：只断言"结构成立"（导入表里有 CUDA 运行时、排查不到 error），
 * **不写死 build 号、CUDA 主版本、驱动版本** —— 那些是环境指纹，不是产品行为。
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../core/config.ts";
import { readPeImports } from "../core/pe.ts";
import { isGgufFile, listBackends, runPrecheck } from "../core/precheck.ts";
import type { LauncherConfig } from "../core/types.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const llamaDir = join(repoRoot, "llama.cpp");
const realExe = join(llamaDir, "llama-server.exe");
const cudaDll = join(llamaDir, "ggml-cuda.dll");
const modelsDir = join(repoRoot, "models");

// 不写死模型名：用户换了模型目录内容后，这条用例不应该因为"文件名过期"而静默跳过
const realModel = (() => {
  if (!existsSync(modelsDir)) return "";
  const hit = readdirSync(modelsDir).find((name) => name.toLowerCase().endsWith(".gguf"));
  return hit === undefined ? "" : join(modelsDir, hit);
})();

test("isGgufFile：本机模型文件是 GGUF", { skip: realModel === "" ? "本机没有模型" : false }, () => {
  assert.equal(isGgufFile(realModel), true);
});

test("listBackends：本机安装里同时有 cpu 与 cuda", { skip: existsSync(llamaDir) ? false : "本机没有 llama.cpp" }, () => {
  const backends = listBackends(llamaDir);
  assert.ok(backends.includes("cpu"), `实际：${backends.join(", ")}`);
  assert.ok(backends.includes("cuda"), `实际：${backends.join(", ")}`);
  assert.equal(backends.includes("base"), false, "ggml-base 是公共库，不是后端");
});

test("runPrecheck：在本机真实环境跑通且不产生 error", { skip: existsSync(realExe) ? false : "本机没有 llama.cpp" }, async (t) => {
  const config: LauncherConfig = {
    ...DEFAULT_CONFIG,
    llama_dir: llamaDir,
    mode: "single",
    main_model: realModel,
  };

  let report;
  try {
    report = await runPrecheck({ config, exe: realExe });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 受限沙箱/CI 里 spawn 被拦时是环境问题，不是产品回归：如实 skip，别报假红
    if (/EPERM|spawn/i.test(message)) {
      t.skip(`无法启动子进程：${message}`);
      return;
    }
    throw error;
  }

  assert.equal(report.facts.exeExists, true);
  assert.ok(report.facts.backends.length > 0);
  assert.ok(report.items.length >= 5);
  const errors = report.items.filter((item) => item.level === "error");
  assert.deepEqual(
    errors.map((item) => `${item.id}: ${item.title}`),
    [],
  );
  assert.ok(["ok", "info", "warn"].includes(report.verdict));
});

test("真实 ggml-cuda.dll：导入表里能读出 CUDA 运行时（版本不写死）", { skip: existsSync(cudaDll) ? false : "本机没有 ggml-cuda.dll" }, () => {
  const result = readPeImports(cudaDll);
  assert.equal(result.error, undefined, `解析失败：${result.error ?? ""}`);
  assert.equal(result.is64, true, "应是 x64");

  const lower = result.imports.map((dll) => dll.toLowerCase());
  assert.ok(lower.some((dll) => /^cudart64_\d+\.dll$/.test(dll)), `导入表：${result.imports.join(", ")}`);
  assert.ok(lower.some((dll) => /^cublas64_\d+\.dll$/.test(dll)), `导入表：${result.imports.join(", ")}`);
  assert.ok(lower.includes("nvcuda.dll"));
  assert.ok(lower.includes("ggml-base.dll"), "应依赖同目录的 ggml-base.dll");
  assert.ok(lower.includes("kernel32.dll"), "应有系统 DLL");
});

test("真实 llama-server.exe：只链系统 DLL 与 impl DLL，不直接链 CUDA", { skip: existsSync(realExe) ? false : "本机没有 llama-server.exe" }, () => {
  const result = readPeImports(realExe);
  assert.equal(result.error, undefined);
  const lower = result.imports.map((dll) => dll.toLowerCase());
  assert.ok(lower.includes("llama-server-impl.dll"));
  assert.ok(lower.includes("kernel32.dll"));
  assert.equal(lower.some((dll) => dll.startsWith("cudart")), false, "CUDA 应由 ggml-cuda.dll 链接");
});
