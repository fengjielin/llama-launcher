import assert from "node:assert/strict";
import { test } from "node:test";
import { configPatchFromPreset, modelNameFromPath } from "../core/presetApply.ts";

/**
 * 口径：presets 是"按模型的参数模板"。
 * router 下由 --models-preset 按模型接管；single 下没有那个参数，
 * 所以选中模型时要把模板填进配置 —— 这两个用例就是这条口径的守卫。
 */

test("预设 → 配置补丁：键名按参数表映射，值按类型收敛", () => {
  const { patch, applied, unknown } = configPatchFromPreset(
    {
      "Qwen3.6-35B-A3B": {
        "ctx-size": 65536,
        "cache-type-k": "q4_0",
        "cache-type-v": "q4_0",
        "n-predict": 8192,
        threads: 6,
        "fit-target": 1024,
        "load-mode": "mmap",
      },
    },
    "Qwen3.6-35B-A3B",
  );

  assert.equal(patch.context, 65536, "ctx-size → context");
  assert.equal(patch.max_predict, 8192, "n-predict → max_predict");
  assert.equal(patch.kv_k_type, "q4_0", "cache-type-k → kv_k_type");
  assert.equal(patch.kv_v_type, "q4_0");
  assert.equal(patch.threads, 6);
  assert.equal(patch.fit_target, 1024);
  assert.equal(patch.load_mode, "mmap");
  assert.deepEqual(unknown, []);
  assert.equal(applied.length, 7);
});

test("预设 → 配置补丁：没写进预设的键不出现（保持配置原值，不被默认值冲掉）", () => {
  const { patch } = configPatchFromPreset({ m: { "ctx-size": 4096 } }, "m");
  assert.deepEqual(Object.keys(patch), ["context"], "只填预设里显式写了的项");
});

test("预设 → 配置补丁：字符串值也能收敛（ini 导入的全是字符串）", () => {
  const { patch } = configPatchFromPreset(
    { m: { "ctx-size": "32768", "n-predict": "8192", "cache-type-k": "q8_0" } },
    "m",
  );
  assert.equal(patch.context, 32768);
  assert.equal(patch.max_predict, 8192);
  assert.equal(patch.kv_k_type, "q8_0");
});

test("预设 → 配置补丁：布尔键认 on/off/true/false", () => {
  const on = configPatchFromPreset({ m: { "flash-attn": "on" } }, "m");
  assert.equal(on.patch.flash_attention, true);
  const off = configPatchFromPreset({ m: { "flash-attn": "false" } }, "m");
  assert.equal(off.patch.flash_attention, false);
});

test("预设 → 配置补丁：键名大小写不敏感；模型没有预设时返回空结果", () => {
  const { patch } = configPatchFromPreset({ m: { "CTX-SIZE": 8192 } }, "m");
  assert.equal(patch.context, 8192);
  assert.deepEqual(configPatchFromPreset({ m: { "ctx-size": 8192 } }, "不存在"), {
    patch: {},
    applied: [],
    unknown: [],
  });
});

test("预设 → 配置补丁：认不出的键与坏值进 unknown，不写进配置", () => {
  const { patch, unknown } = configPatchFromPreset(
    { m: { "ctx-size": "不是数字", "根本不存在的键": 1, "n-predict": 512 } },
    "m",
  );
  assert.deepEqual(Object.keys(patch), ["max_predict"], "只有合法项被填入");
  assert.deepEqual(unknown.sort(), ["ctx-size", "根本不存在的键"].sort());
});

test("modelNameFromPath：去掉 .gguf、合并分片、容忍反斜杠", () => {
  assert.equal(modelNameFromPath("E:\\models\\Qwen3.6-35B-A3B.gguf"), "Qwen3.6-35B-A3B");
  assert.equal(modelNameFromPath("/home/u/models/abc-00001-of-00003.gguf"), "abc");
  assert.equal(modelNameFromPath("E:\\models\\mmproj\\随便.gguf"), "随便");
  assert.equal(modelNameFromPath("E:\\models\\没有后缀"), "没有后缀");
  assert.equal(modelNameFromPath(""), "");
});
