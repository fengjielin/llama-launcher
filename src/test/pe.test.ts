import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readPeImports } from "../core/pe.ts";
import { withTempDir } from "./helpers.ts";

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures");

// 真实 ggml-cuda.dll / llama-server.exe 的解析在 env.test.ts：依赖本机安装，
// 默认套件只保留"不依赖装了什么"的坏输入分支。

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

test("真·空文件：报错但不抛异常", () => {
  withTempDir("llama-pe-empty-", (dir) => {
    const path = join(dir, "empty.dll");
    writeFileSync(path, "");
    const result = readPeImports(path);
    assert.equal(result.imports.length, 0);
    assert.ok(result.error !== undefined);
  });
});
