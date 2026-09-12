import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectPresetKeys,
  getNumericPresetValue,
  mergePresets,
  parsePresetsIni,
  presetFileFromJson,
  presetKeysForModel,
  presetsJsonFromPresetFile,
  renderPresetFile,
  stagePresetText,
} from "../core/presets.ts";

const ini = readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "presets.sample.ini"), "utf8");

/** 用户那份 ini 里真实存在的 5 个模型段 */
const REAL_MODELS = [
  "Qwen3.8-27B-Uncensored-IQ4_XS",
  "Qwen3.8-27B-Uncensored-IQ2_M",
  "qwen2.5-7b-instruct-q4_k_m",
  "qwen2.5-7b-instruct-q5_k_m",
  "meta-llama.Meta-Llama-3-8B-Instruct.Q4_K_M",
];

// ---------------------------------------------------------------------------
// 导入来源：ini 解析（只保留给「导入 presets.ini」用）
// ---------------------------------------------------------------------------

test("解析真实 presets.ini（用户现有那份）", () => {
  const file = parsePresetsIni(ini);
  assert.ok(file.sections.has("Qwen3.8-27B-Uncensored-IQ4_XS"));
  assert.ok(file.sections.has("Qwen3.8-27B-Uncensored-IQ2_M"));
  assert.ok(file.sections.has("qwen2.5-7b-instruct-q4_k_m"));
  assert.equal(getNumericPresetValue(file, "Qwen3.8-27B-Uncensored-IQ4_XS", "ctx-size"), 16384);
  assert.equal(getNumericPresetValue(file, "qwen2.5-7b-instruct-q4_k_m", "ctx-size"), 32768);
  // 非数值键不该被解析成数字
  assert.equal(getNumericPresetValue(file, "qwen2.5-7b-instruct-q4_k_m", "cache-type-k"), null);
  assert.equal(getNumericPresetValue(file, "不存在的模型", "ctx-size"), null);
});

test("[defaults] 段的注释形式 default-model 能被读到（导入时据此填 preload_model）", () => {
  const file = parsePresetsIni(ini);
  assert.equal(file.defaultModel, "Qwen3.8-27B-Uncensored-IQ4_XS");
});

test("BOM 容忍 / 注释行 / 大小写键名归一", () => {
  const withBom = "\ufeff; 顶部注释\r\n[defaults]\r\n; default-model = abc\r\n[m1]\r\nCtx-Size = 1024\r\ncache-type-k = q8_0\r\n";
  const file = parsePresetsIni(withBom);
  assert.equal(file.defaultModel, "abc");
  assert.equal(getNumericPresetValue(file, "m1", "ctx-size"), 1024);
  assert.equal(file.sections.get("m1")?.get("cache-type-k"), "q8_0");
  assert.deepEqual(file.rawKeys.get("m1"), ["Ctx-Size", "cache-type-k"], "原始大小写要保留，便于展示");
});

// ---------------------------------------------------------------------------
// 导入：ini → JSON
// ---------------------------------------------------------------------------

test("导入：ini 转成 JSON 预设，[defaults] 不进模型表", () => {
  const json = presetsJsonFromPresetFile(parsePresetsIni(ini));

  assert.deepEqual(Object.keys(json).sort(), [...REAL_MODELS].sort());
  assert.equal(json["defaults"], undefined, "[defaults] 是启动器自用段，不该出现在模型表里");
  // 整数写成 JSON 数字（好看），其它保持字符串
  assert.equal(json["Qwen3.8-27B-Uncensored-IQ4_XS"]?.["ctx-size"], 16384);
  assert.equal(json["Qwen3.8-27B-Uncensored-IQ4_XS"]?.["cache-type-k"], "q4_0");
  assert.equal(json["qwen2.5-7b-instruct-q5_k_m"]?.["load-mode"], "mmap+mlock");
});

test("导入后再渲染：键值一条不差（ini → JSON → ini 往返）", () => {
  const json = presetsJsonFromPresetFile(parsePresetsIni(ini));
  const rendered = renderPresetFile(presetFileFromJson(json));
  const back = parsePresetsIni(rendered);

  assert.equal(back.sections.size, 5, "5 个模型段都要在");
  for (const model of REAL_MODELS) {
    const before = parsePresetsIni(ini).sections.get(model)!;
    const after = back.sections.get(model)!;
    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort(), `${model} 的键值应完全一致`);
  }
  assert.equal(back.sections.has("defaults"), false, "渲染出来的 ini 不该有 [defaults]");
  assert.equal(getNumericPresetValue(back, "Qwen3.8-27B-Uncensored-IQ4_XS", "ctx-size"), 16384);
});

// ---------------------------------------------------------------------------
// 主路径：JSON 预设 → 内存形态 → 渲染
// ---------------------------------------------------------------------------

test("presetFileFromJson：键名小写化、原始大小写另存、值统一转字符串", () => {
  const file = presetFileFromJson({
    模型A: { "Ctx-Size": 8192, "cache-type-k": "q4_0", "flash-attn": true },
  });
  assert.deepEqual([...file.sections.get("模型A")!.entries()], [
    ["ctx-size", "8192"],
    ["cache-type-k", "q4_0"],
    ["flash-attn", "true"],
  ]);
  assert.deepEqual(file.rawKeys.get("模型A"), ["Ctx-Size", "cache-type-k", "flash-attn"], "渲染时还原用户写的键名");
  assert.equal(file.defaultModel, null);
});

test("renderPresetFile：段名即模型名，键值写什么就是什么，行尾统一 \\n", () => {
  const text = renderPresetFile(
    presetFileFromJson({
      "qwen2.5-7b-instruct-q4_k_m": { "ctx-size": 32768, "cache-type-k": "q8_0" },
      模型B: { "load-mode": "mmap+mlock" },
    }),
  );
  assert.equal(
    text,
    "[qwen2.5-7b-instruct-q4_k_m]\nctx-size = 32768\ncache-type-k = q8_0\n\n[模型B]\nload-mode = mmap+mlock\n",
  );
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.includes("\r"), false);
});

test("renderPresetFile：空参数表的段不写（免得服务器把它当成占位模型）", () => {
  const text = renderPresetFile(presetFileFromJson({ 模型A: {}, 模型B: { "ctx-size": 4096 } }));
  assert.equal(text.includes("模型A"), false);
  assert.equal(text.includes("[模型B]"), true);
  assert.equal(renderPresetFile(presetFileFromJson({})), "", "一个预设都没有时返回空串");
});

test("preset 接管判断用的是键名并集/单模型键（命令行不再重复传）", () => {
  const file = presetFileFromJson({
    模型A: { "ctx-size": 8192, threads: 6 },
    模型B: { "cache-type-k": "q4_0" },
  });
  assert.deepEqual(collectPresetKeys(file).sort(), ["cache-type-k", "ctx-size", "threads"]);
  assert.deepEqual(presetKeysForModel(file, "模型B"), ["cache-type-k"]);
  assert.deepEqual(presetKeysForModel(file, "不存在"), []);
});

test("导入合并：同名模型保留现有配置，只补新的", () => {
  const existing = { 模型A: { "ctx-size": 4096 } };
  const imported = { 模型A: { "ctx-size": 8192 }, 模型B: { threads: 6 } };
  const { presets, added, skipped } = mergePresets(existing, imported);

  assert.equal(presets["模型A"]?.["ctx-size"], 4096, "同名模型不能被导入覆盖");
  assert.deepEqual(presets["模型B"], { threads: 6 });
  assert.deepEqual(added, ["模型B"]);
  assert.deepEqual(skipped, ["模型A"]);
  assert.deepEqual(existing, { 模型A: { "ctx-size": 4096 } }, "不该改动入参");
});

test("stagePresetText 写出的文件不带 BOM", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llama-launcher-stage-"));
  const target = stagePresetText("[m]\nctx-size = 4096\n", tmp);
  const bytes = readFileSync(target);
  assert.notDeepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], "带 BOM 会让 llama-server 解析失败");
  assert.equal(readFileSync(target, "utf8").startsWith("[m]"), true);
});
