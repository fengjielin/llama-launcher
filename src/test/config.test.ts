import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CONFIG,
  loadConfigFile,
  normalizeConfig,
  normalizeThink,
  resolveModelFile,
  saveConfigFile,
} from "../core/config.ts";

/** 一份"手写风格"的配置：含 K 写法的 context、额外未知键、显式采样值 */
const handwrittenConfig = {
  llama_dir: "E:/Code/llama/llama.cpp",
  main_model: "E:/Code/llama/models/Qwen3.8-27B-Uncensored-IQ4_XS.gguf",
  vision_model: "",
  draft_model: "",
  host: "0.0.0.0",
  port: 8001,
  parallel: "-1",
  context: 64,
  gpu_layers: "auto",
  main_gpu: "0",
  temperature: 0.6,
  top_p: 0.95,
  top_k: 20,
  min_p: 0.0,
  presence_penalty: 0.0,
  batch_size: 2048,
  ubatch_size: 512,
  repeat_penalty: 1.0,
  cpu_moe: 0,
  kv_k_type: "q4_0",
  kv_v_type: "q4_0",
  split_mode: "none",
  think: false,
  flash_attention: true,
  tools_all: false,
  mlock: true,
  agent: false,
  reasoning_preserve: false,
  reasoning_effort: "low",
  spec_type: "draft-mtp",
  draft_n: 2,
  draft_type_k: "q4_0",
  draft_type_v: "q4_0",
  api_key: "",
  log_file: "qwen3.8-27b-log.json",
  custom_args: "",
  /** 启动器不认识的键：应原样保留 */
  某个没建模的键: "值",
};

test("归一化：未知键原样保留、context 单位识别、采样显式值不被联动覆盖", () => {
  const { config, warnings } = normalizeConfig(handwrittenConfig);

  assert.equal(config.mode, "single");
  assert.equal(config.think, "off", "think:false 应归一成 off");
  assert.equal(config.port, 8001);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.parallel, -1);
  assert.equal(config["某个没建模的键"], "值", "未知键要保留，不丢数据");
  assert.equal(config.log_file, "qwen3.8-27b-log.json");

  // context=64 不可能是 token 数（16K 档位在 PS1 里是 32768），按 K 解释
  assert.equal(config.context, 65536);
  assert.equal(config.max_predict, DEFAULT_CONFIG.max_predict, "没写过就用默认值");

  // 用户显式写过的采样值不能被"思考模式联动"覆盖
  assert.equal(config.temperature, 0.6);
  assert.equal(config.top_p, 0.95);
  assert.equal(config.presence_penalty, 0);

  assert.ok(warnings.some((w) => w.includes("context=64")), warnings.join(" | "));
  assert.ok(warnings.some((w) => w.includes("draft-mtp")), "spec_type 需要草稿模型但没有 → 要告警");
});

test("resolveModelFile：single 模式主模型留空时按 preload_model 兜底", () => {
  const base = { llama_dir: "E:\\Code\\llama\\llama.cpp", models_dir: "E:\\Code\\llama\\models" };

  // 主模型写了就用它
  assert.equal(
    resolveModelFile({ ...base, mode: "single", main_model: "E:\\m\\explicit.gguf", preload_model: "默认模型" }),
    "E:\\m\\explicit.gguf",
  );
  // 留空则用 preload_model + models_dir 拼出来（这就是"从 JSON 里读"）
  assert.equal(
    resolveModelFile({ ...base, mode: "single", preload_model: "Qwen3.8-27B-Uncensored-IQ4_XS" }),
    join("E:\\Code\\llama\\models", "Qwen3.8-27B-Uncensored-IQ4_XS.gguf"),
  );
  // 两处都没有 → null（调用方据此告警）
  assert.equal(resolveModelFile({ ...base, mode: "single" }), null);
  // 有 preload_model 但没有 models_dir 也拼不出来
  assert.equal(resolveModelFile({ mode: "single", preload_model: "X" }), null);
});

test("resolveModelFile：router 模式只看预加载模型，不看 main_model", () => {
  const config = {
    mode: "router" as const,
    models_dir: "E:\\models",
    preload_model: "A",
    main_model: "E:\\m\\随便.gguf",
  };
  assert.equal(resolveModelFile(config), join("E:\\models", "A.gguf"));
  assert.equal(resolveModelFile({ ...config, preload_model: "" }), null, "router 没配预加载就没有要加载的模型");
});

test("resolveModelFile：mustExist 会真的去看文件在不在", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-modelfile-"));
  try {
    writeFileSync(join(dir, "在的.gguf"), "", "utf8");
    const config = { mode: "single" as const, models_dir: dir, preload_model: "在的" };
    assert.equal(resolveModelFile(config), join(dir, "在的.gguf"), "默认不查存在性");
    assert.equal(resolveModelFile(config, { mustExist: true }), join(dir, "在的.gguf"));
    assert.equal(
      resolveModelFile({ ...config, preload_model: "不在的" }, { mustExist: true }),
      null,
      "不存在时给不出建议",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("思考模式联动：采样默认值与生成上限", () => {
  const on = normalizeConfig({ llama_dir: "X", think: "on", max_predict: 2048, context: 32768 });
  assert.equal(on.config.temperature, 0.6, "思考模式用 Qwen3 官方那套");
  assert.equal(on.config.top_p, 0.95);
  assert.equal(on.config.presence_penalty, 0.5);
  assert.equal(on.config.max_predict, 16384, "开思考必须放宽生成上限");
  assert.ok(on.warnings.some((w) => w.includes("16384")));

  const off = normalizeConfig({ llama_dir: "X", think: "off" });
  assert.equal(off.config.temperature, 0.7);
  assert.equal(off.config.top_p, 0.8);
  assert.equal(off.config.presence_penalty, 1);
  assert.equal(off.config.max_predict, DEFAULT_CONFIG.max_predict);

  const explicit = normalizeConfig({ llama_dir: "X", think: "on", temperature: 0.1 });
  assert.equal(explicit.config.temperature, 0.1, "显式值优先");
});

test("生成上限不小于上下文时告警（上限会失效）", () => {
  const { warnings } = normalizeConfig({ llama_dir: "X", context: 4096, max_predict: 8192 });
  assert.ok(warnings.some((w) => w.includes("上限")), warnings.join(" | "));
});

test("关掉 Flash Attention 时 V cache 量化失效，只压 K", () => {
  const { config, warnings } = normalizeConfig({
    llama_dir: "X",
    flash_attention: false,
    kv_k_type: "q4_0",
    kv_v_type: "q4_0",
  });
  assert.equal(config.kv_k_type, "q4_0");
  assert.equal(config.kv_v_type, "f16", "V 侧必须有 FA 撑着，否则退回 f16");
  assert.ok(warnings.some((w) => w.includes("Flash Attention")));
});

test("默认 single：只给 models_dir 不再推断成 router，显式 mode 才作数", () => {
  assert.equal(normalizeConfig({ models_dir: "E:/m" }).config.mode, "single", "有模型目录不等于要 router");
  assert.equal(normalizeConfig({ mode: "router", models_dir: "E:/m" }).config.mode, "router");
  assert.equal(normalizeConfig({ mode: "single", models_dir: "E:/m" }).config.mode, "single");
  assert.equal(normalizeConfig({}).config.mode, "single");
});

test("normalizeThink 各种写法", () => {
  assert.equal(normalizeThink(true), "on");
  assert.equal(normalizeThink(false), "off");
  assert.equal(normalizeThink("ON"), "on");
  assert.equal(normalizeThink("auto"), "auto");
  assert.equal(normalizeThink(""), null);
  assert.equal(normalizeThink(undefined), null);
  assert.equal(normalizeThink("看不懂"), null);
});

test("配置读写往返：UTF-8 且不带 BOM", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-cfg-"));
  const path = join(dir, "llama-launcher.json");
  saveConfigFile(path, {
    ...DEFAULT_CONFIG,
    llama_dir: "E:/Code/llama/llama.cpp",
    port: 8001,
    custom_args: "--no-kv-offload",
  });

  const text = readFileSync(path, "utf8");
  assert.equal(text.charCodeAt(0) === 0xfeff, false, "写 BOM 会让下游解析出问题");

  const back = loadConfigFile(path);
  assert.equal(back.config.port, 8001);
  assert.equal(back.config.custom_args, "--no-kv-offload");
  assert.equal(back.config.llama_dir, "E:/Code/llama/llama.cpp");
  assert.equal(back.config.context, DEFAULT_CONFIG.context, "32768 不该被当成 K 解释");
});

test("空对象/垃圾输入不崩", () => {
  assert.equal(normalizeConfig(null).config.port, DEFAULT_CONFIG.port);
  assert.equal(normalizeConfig("不是对象").config.host, DEFAULT_CONFIG.host);
  assert.equal(normalizeConfig(42).config.mode, "single");
});
