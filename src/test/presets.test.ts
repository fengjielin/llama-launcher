import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  collectPresetKeys,
  getNumericPresetValue,
  hasNonAsciiPath,
  parsePresetsIni,
  presetKeysForModel,
  renderPresetForServer,
  stagePresetIfNonAscii,
  stagePresetText,
} from "../core/presets.ts";

const ini = readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "presets.sample.ini"), "utf8");

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

test("键名取并集（与 llama-oneclick.ps1 的 NotInPreset 行为一致）", () => {
  const file = parsePresetsIni(ini);
  const keys = collectPresetKeys(file);
  for (const key of ["ctx-size", "cache-type-k", "cache-type-v", "fit-target", "load-mode", "threads"]) {
    assert.ok(keys.includes(key), `并集里应包含 ${key}`);
  }
  assert.equal(keys.includes("default-model"), false, "[defaults] 段的键不参与并集");
  assert.equal(keys.includes("n-predict"), false, "没在任何模型段出现过的键不该出现");
});

test("单模型段的键", () => {
  const file = parsePresetsIni(ini);
  assert.deepEqual(
    presetKeysForModel(file, "Qwen3.8-27B-Uncensored-IQ2_M").sort(),
    ["cache-type-k", "cache-type-v", "ctx-size", "fit-target", "load-mode", "threads"].sort(),
  );
  assert.deepEqual(presetKeysForModel(file, "不存在"), []);
});

test("[defaults] 段的注释形式 default-model 能被读到（PS1 也是这么读的）", () => {
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

test("非 ASCII 路径识别", () => {
  assert.equal(hasNonAsciiPath("E:\\Code\\llama\\一键启动脚本\\presets.ini"), true);
  assert.equal(hasNonAsciiPath("E:\\Code\\llama\\presets.ini"), false);
  assert.equal(hasNonAsciiPath("E:\\Code\\llama\\中文目录"), true);
});

test("非 ASCII 的 presets 路径会被拷到 ASCII 目录（否则 llama-server 直接崩退）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llama-launcher-presets-"));
  const asciiTarget = join(tmp, "presets.ini");
  writeFileSync(asciiTarget, "[m]\nctx-size = 4096\n", "utf8");
  assert.deepEqual(stagePresetIfNonAscii(asciiTarget, tmp), { argPath: asciiTarget, copied: false });

  const source = join(tmp, "中文目录", "presets.ini");
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, "[m]\nctx-size = 8192\n", "utf8");

  const staged = stagePresetIfNonAscii(source, tmp);
  assert.equal(staged.copied, true);
  assert.equal(hasNonAsciiPath(staged.argPath), false);
  assert.equal(getNumericPresetValue(parsePresetsIni(readFileSync(staged.argPath, "utf8")), "m", "ctx-size"), 8192);
});

test("传给 llama-server 的 presets 要剔掉 [defaults]（实测它会被当成一个假模型）", () => {
  const { text, removedSections } = renderPresetForServer(ini);
  assert.deepEqual(removedSections, ["defaults"]);

  const forServer = parsePresetsIni(text);
  assert.equal(forServer.sections.has("defaults"), false, "[defaults] 不能出现在给 llama-server 的文件里");
  assert.equal(forServer.sections.size, 5, "5 个真实模型段要全部保留");
  for (const name of [
    "Qwen3.8-27B-Uncensored-IQ4_XS",
    "Qwen3.8-27B-Uncensored-IQ2_M",
    "qwen2.5-7b-instruct-q4_k_m",
    "qwen2.5-7b-instruct-q5_k_m",
    "meta-llama.Meta-Llama-3-8B-Instruct.Q4_K_M",
  ]) {
    assert.equal(forServer.sections.has(name), true, `应保留 ${name}`);
  }
  // 模型段的键一个都不能少
  assert.equal(getNumericPresetValue(forServer, "Qwen3.8-27B-Uncensored-IQ4_XS", "ctx-size"), 16384);
  assert.equal(forServer.sections.get("Qwen3.8-27B-Uncensored-IQ2_M")?.get("load-mode"), "mmap+mlock");
});

test("stagePresetText 写出的文件不带 BOM", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llama-launcher-stage-"));
  const target = stagePresetText("[m]\nctx-size = 4096\n", tmp);
  const bytes = readFileSync(target);
  assert.notDeepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], "带 BOM 会让 llama-server 解析失败");
  assert.equal(readFileSync(target, "utf8").startsWith("[m]"), true);
});
