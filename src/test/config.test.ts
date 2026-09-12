import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfigFile, normalizeConfig, normalizeThink, saveConfigFile } from "../core/config.ts";

/** llamaServer启动器 v1.9 写出来的配置（原样抄自用户目录里的那份） */
const v19Config = {
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
  mcp_proxy: true,
  推测技术: true,
  reasoning_effort: "low",
  spec_type: "draft-mtp",
  draft_n: 2,
  cpu_threads: -1,
  draft_type_k: "q4_0",
  draft_type_v: "q4_0",
  api_key: "",
  log_file: "qwen3.8-27b-log.json",
  custom_args: "",
};

test("v1.9 配置迁移：键名映射、未知键保留、上下文单位识别", () => {
  const { config, warnings } = normalizeConfig(v19Config);

  assert.equal(config.mode, "single");
  assert.equal(config.think, "off", "think:false 应归一成 off");
  assert.equal(config.threads, -1, "cpu_threads → threads，且不能被后面的默认值冲掉");
  assert.equal(config.spec_enabled, true, "推测技术 → spec_enabled");
  assert.equal(config.port, 8001);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.parallel, -1);
  assert.equal(config.mcp_proxy, true, "未知键原样保留");
  assert.equal(config.log_file, "qwen3.8-27b-log.json");

  // context=64 不可能是 token 数（16G 档位在 PS1 里是 32768），按 K 解释
  assert.equal(config.context, 65536);
  assert.equal(config.max_predict, 8192, "v1.9 没有这个键，用默认值");

  // 用户显式写过的采样值不能被"思考模式联动"覆盖
  assert.equal(config.temperature, 0.6);
  assert.equal(config.top_p, 0.95);
  assert.equal(config.presence_penalty, 0);

  assert.ok(warnings.some((w) => w.includes("v1.9")), warnings.join(" | "));
  assert.ok(warnings.some((w) => w.includes("context=64")));
  assert.ok(warnings.some((w) => w.includes("MCP")));
  assert.ok(warnings.some((w) => w.includes("draft-mtp")), "spec_type 需要草稿模型但没有 → 要告警");
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

test("给了 models_dir 就推断成 router 模式，显式 mode 优先", () => {
  assert.equal(normalizeConfig({ models_dir: "E:/m" }).config.mode, "router");
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
