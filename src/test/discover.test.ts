import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverLlamaDir } from "../core/config.ts";
import { makeLlamaDir } from "./helpers.ts";

test("向上回溯：从深层目录能找到祖先下的 llama.cpp（打包版的实际布局）", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-discover-"));
  try {
    // 模拟：<root>\llama.cpp 与 <root>\llama-launcher\dist\win-unpacked\
    const llamaDir = makeLlamaDir(join(root, "llama.cpp"));
    const exeDir = join(root, "llama-launcher", "dist", "win-unpacked");
    mkdirSync(exeDir, { recursive: true });

    // 从 win-unpacked 出发要找三层才到 <root>，默认 maxUpLevels=3 够
    assert.equal(discoverLlamaDir([exeDir], {}), llamaDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("向上回溯：超过层数上限就找不到（不会无限往上猜）", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-discover-depth-"));
  try {
    makeLlamaDir(join(root, "llama.cpp"));
    const deep = join(root, "a", "b", "c", "d", "e");
    mkdirSync(deep, { recursive: true });
    // 默认 3 层不够（llama.cpp 在第 5 层）
    assert.equal(discoverLlamaDir([deep], {}), null);
    // 放宽到 5 层就能找到
    assert.ok(discoverLlamaDir([deep], {}, 5) !== null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("起点目录本身就是 llama.cpp 目录（第 0 层直接命中）", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-discover-self-"));
  try {
    const llamaDir = makeLlamaDir(join(root, "build"));
    assert.equal(discoverLlamaDir([llamaDir], {}), llamaDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("起点下面的 llama.cpp 子目录（第 0 层候选）", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-discover-child-"));
  try {
    const llamaDir = makeLlamaDir(join(root, "tools", "llama.cpp"));
    assert.equal(discoverLlamaDir([join(root, "tools")], {}), llamaDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("多个起点按顺序尝试，前一个找不到就用后一个", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-discover-multi-"));
  try {
    const second = join(root, "second");
    const llamaDir = makeLlamaDir(join(second, "llama.cpp"));
    assert.equal(discoverLlamaDir([join(root, "不存在"), second], {}), llamaDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("环境变量优先于目录回溯：LLAMA_SERVER / LLAMA_DIR", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-discover-env-"));
  try {
    const llamaDir = makeLlamaDir(join(root, "llama.cpp"));
    const other = makeLlamaDir(join(root, "别处", "另一个构建"));

    // LLAMA_SERVER 直接给 exe
    assert.equal(discoverLlamaDir([root], { LLAMA_SERVER: join(other, "llama-server.exe") }), other);
    // LLAMA_DIR 给目录
    assert.equal(discoverLlamaDir([other], { LLAMA_DIR: llamaDir }), llamaDir);
    // 环境变量指向不存在的路径时忽略它，继续走目录回溯
    assert.equal(discoverLlamaDir([root], { LLAMA_DIR: join(root, "没有这个") }), llamaDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("全都找不到时返回 null（不猜、不抛异常）", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-discover-none-"));
  try {
    assert.equal(discoverLlamaDir([root], {}), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
