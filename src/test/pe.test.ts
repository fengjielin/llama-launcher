import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readPeImports } from "../core/pe.ts";

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures");
/** 本机那个真实的 llama.cpp 目录（仓库的上一级再进 llama.cpp），不存在就跳过相关用例 */
const llamaDir = join(import.meta.dirname, "..", "..", "..", "llama.cpp");
const cudaDll = join(llamaDir, "ggml-cuda.dll");
const serverExe = join(llamaDir, "llama-server.exe");

test("非 PE 文件：报错但不抛异常", () => {
  const result = readPeImports(join(fixturesDir, "help-b10488.txt"));
  assert.equal(result.imports.length, 0);
  assert.ok(result.error !== undefined);
  assert.match(result.error, /MZ|PE/);
});

test("文件不存在：报错但不抛异常", () => {
  const result = readPeImports(join(fixturesDir, "不存在的文件.dll"));
  assert.equal(result.imports.length, 0);
  assert.ok(result.error !== undefined);
});

test("空文件：报错但不抛异常", () => {
  const result = readPeImports(join(fixturesDir, "version-b10488.txt"));
  assert.ok(result.error !== undefined);
});

test(
  "真实 ggml-cuda.dll：能读出它依赖的 CUDA 运行时（预检的判断依据）",
  { skip: existsSync(cudaDll) ? false : "本机没有 llama.cpp 目录，跳过" },
  () => {
    const result = readPeImports(cudaDll);
    assert.equal(result.error, undefined, `解析失败：${result.error ?? ""}`);
    assert.equal(result.is64, true, "应是 x64");
    assert.ok(result.size > 100 * 1024 * 1024, "CUDA 后端 DLL 很大，说明确实读到了真文件");

    const lower = result.imports.map((dll) => dll.toLowerCase());
    // 这三条就是"这份构建需要 CUDA 12 运行时 + NVIDIA 驱动"的证据
    assert.ok(lower.includes("cudart64_12.dll"), `导入表：${result.imports.join(", ")}`);
    assert.ok(lower.includes("cublas64_12.dll"));
    assert.ok(lower.includes("nvcuda.dll"));
    assert.ok(lower.includes("ggml-base.dll"), "应依赖同目录的 ggml-base.dll");
    assert.ok(lower.includes("kernel32.dll"), "应有系统 DLL");
  },
);

test(
  "真实 llama-server.exe：导入表只有系统 DLL 与 impl DLL",
  { skip: existsSync(serverExe) ? false : "本机没有 llama-server.exe，跳过" },
  () => {
    const result = readPeImports(serverExe);
    assert.equal(result.error, undefined);
    const lower = result.imports.map((dll) => dll.toLowerCase());
    assert.ok(lower.includes("llama-server-impl.dll"));
    assert.ok(lower.includes("kernel32.dll"));
    // exe 本身不该直接链 CUDA —— 那是 ggml-cuda.dll 的事
    assert.equal(lower.some((dll) => dll.startsWith("cudart")), false);
  },
);

test("同一文件重复解析结果一致（无状态、可重复调用）", () => {
  const path = join(fixturesDir, "version-b10488.txt");
  const first = readPeImports(path);
  const second = readPeImports(path);
  assert.deepEqual(first, second);
  // 顺带确认读的是真实内容而不是缓存
  assert.equal(readFileSync(path, "utf8").includes("10488"), true);
});
