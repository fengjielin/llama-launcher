import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { discoverModelLayout } from "../core/config.ts";

/**
 * 造一个假的 llama.cpp 目录（只要有一个 llama-server.exe，探测就认）。
 *
 * @param dir 目标目录
 * @returns 该目录的绝对路径
 */
function makeLlamaDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.exe"), "", "utf8");
  return resolve(dir);
}

test("模型布局探测：同级有 models 与 presets.ini → router + 预加载", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-layout-full-"));
  try {
    const llamaDir = makeLlamaDir(join(root, "llama.cpp"));
    const modelsDir = join(root, "models");
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(modelsDir, "Qwen3-27B.gguf"), "", "utf8");
    // 既有 PS1 的约定：注释形式的 default-model 也生效
    writeFileSync(
      join(root, "presets.ini"),
      "[defaults]\n; default-model = Qwen3-27B\n\n[Qwen3-27B]\nctx = 65536\n",
      "utf8",
    );

    const layout = discoverModelLayout({
      startDirs: [join(root, "llama-launcher", "dist", "win-unpacked")],
      env: {},
    });
    assert.equal(layout.llamaDir, llamaDir);
    assert.equal(layout.modelsDirCandidate, modelsDir);
    assert.equal(layout.modelsDirExists, true);
    assert.equal(layout.presetPath, join(root, "presets.ini"));
    assert.equal(layout.preloadModel, "Qwen3-27B", "presets.ini 里写过的默认模型，且模型文件在 → 预加载");
    assert.equal(layout.mode, "router", "有 presets.ini 就用 router");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("模型布局探测：presets.ini 在「一键启动脚本」子目录里也认", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-layout-sub-"));
  try {
    makeLlamaDir(join(root, "llama.cpp"));
    mkdirSync(join(root, "models"), { recursive: true });
    const preset = join(root, "一键启动脚本", "presets.ini");
    mkdirSync(join(root, "一键启动脚本"), { recursive: true });
    writeFileSync(preset, "[defaults]\n", "utf8");

    const layout = discoverModelLayout({ startDirs: [root], env: {} });
    assert.equal(layout.presetPath, preset);
    assert.equal(layout.mode, "router");
    assert.equal(layout.preloadModel, "", "没有 default-model 就不预加载");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("模型布局探测：没有 presets.ini → single，且 models 目录照样给出候选路径", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-layout-single-"));
  try {
    const llamaDir = makeLlamaDir(join(root, "llama.cpp"));
    mkdirSync(join(root, "models"), { recursive: true });

    const layout = discoverModelLayout({ startDirs: [llamaDir], env: {} });
    assert.equal(layout.mode, "single");
    assert.equal(layout.modelsDirExists, true, "目录存在就要认出来（界面靠它给「填入」按钮）");
    assert.equal(layout.presetPath, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("模型布局探测：models 目录不存在时只给候选、不给存在标记", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-layout-nomodels-"));
  try {
    const llamaDir = makeLlamaDir(join(root, "llama.cpp"));
    const layout = discoverModelLayout({ startDirs: [llamaDir], env: {} });
    assert.equal(layout.modelsDirCandidate, join(root, "models"));
    assert.equal(layout.modelsDirExists, false, "不能把不存在的目录当成探测到了");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("模型布局探测：presets.ini 里写了默认模型但文件不在 → 不预加载（免得启动即失败）", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-layout-missing-gguf-"));
  try {
    makeLlamaDir(join(root, "llama.cpp"));
    mkdirSync(join(root, "models"), { recursive: true });
    writeFileSync(join(root, "presets.ini"), "[defaults]\n; default-model = 不存在的模型\n", "utf8");

    const layout = discoverModelLayout({ startDirs: [root], env: {} });
    assert.equal(layout.preloadModel, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("模型布局探测：显式给了 llama.cpp 目录就不再回溯（CLI --llama-dir 用）", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-layout-explicit-"));
  try {
    // 「别处/构建」只能靠显式指定找到；root\llama.cpp 才是回溯能找到的（回溯是往上找的）
    const explicit = makeLlamaDir(join(root, "别处", "构建"));
    mkdirSync(join(root, "别处", "models"), { recursive: true });
    const auto = makeLlamaDir(join(root, "llama.cpp"));

    const given = discoverModelLayout({ startDirs: [root], explicitLlamaDir: explicit, env: {} });
    assert.equal(given.llamaDir, explicit, "显式给了就用显式值");
    assert.equal(given.modelsDirCandidate, join(root, "别处", "models"), "models 候选跟着显式目录走");

    for (const empty of ["", null, undefined]) {
      const fell = discoverModelLayout({ startDirs: [root], explicitLlamaDir: empty, env: {} });
      assert.equal(fell.llamaDir, auto, `explicitLlamaDir=${String(empty)} 时应退回回溯`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("模型布局探测：什么都探不到时返回空布局（不抛异常）", () => {
  const root = mkdtempSync(join(tmpdir(), "llama-layout-none-"));
  try {
    const layout = discoverModelLayout({ startDirs: [root], env: {} });
    assert.equal(layout.llamaDir, null);
    assert.equal(layout.modelsDirCandidate, "");
    assert.equal(layout.modelsDirExists, false);
    assert.equal(layout.presetPath, "");
    assert.equal(layout.preloadModel, "");
    assert.equal(layout.mode, "single");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
