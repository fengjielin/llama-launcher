import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, diagnose, LineSplitter } from "../core/logLines.ts";

test("行缓冲：被 chunk 边界切断的行必须拼回来", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push("abc\ndef"), ["abc"], "第一块末尾是半行，不能吐出来");
  assert.deepEqual(s.push("gh\r\nkl"), ["defgh"], "跨块拼回整行，并且去掉 \\r");
  assert.deepEqual(s.flush(), ["kl"]);
  assert.equal(s.pending, "");
  assert.deepEqual(s.flush(), []);
});

test("行缓冲：连续多行一次到达", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push("l1\nl2\nl3\n"), ["l1", "l2", "l3"]);
  assert.equal(s.pending, "");
});

test("行缓冲：超长无换行输出不会撑爆内存", () => {
  const s = new LineSplitter();
  const huge = "x".repeat(1_000_001);
  const lines = s.push(huge);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 1_000_001);
  assert.equal(s.pending, "");
});

test("日志分类：监听 / 性能 / 上下文 / 显存不足", () => {
  const listening = classify("main: server is listening on http://127.0.0.1:8080 - starting the main loop");
  assert.equal(listening.kind, "listening");

  const perf = classify("prompt eval time = 123.45 ms / 456 tokens (   0.27 ms per token,  3729.42 tokens per second)");
  assert.equal(perf.kind, "perf");
  assert.equal(perf.metrics.promptEvalTokPerSec, 3729.42);

  const gen = classify("      eval time = 1000.00 ms /   100 tokens (  10.00 ms per token,   100.00 tokens per second)");
  assert.equal(gen.kind, "perf");
  assert.equal(gen.metrics.evalTokPerSec, 100);

  const ctx = classify("llama_context: n_ctx = 16384");
  assert.equal(ctx.metrics.nCtx, 16384);

  const offload = classify("load_tensors: offloaded 33/33 layers to GPU");
  assert.equal(offload.metrics.offloadedLayers, "33/33");

  const oom = classify("CUDA error: out of memory");
  assert.equal(oom.kind, "oom");
  assert.equal(oom.level, "error");

  const warn = classify("llama_model_loader: warning: model has no chat template");
  assert.equal(warn.kind, "warning");
  assert.equal(warn.level, "warn");
});

test("结构化日志前缀（b10488 实测格式）优先于关键词猜测", () => {
  // 这行不含 warn 字样，只能靠等级字母识别
  const cors = classify("0.00.146.987 W srv  llama_server: CORS is set to allow all origins ('*') and no API key is set");
  assert.equal(cors.kind, "warning");
  assert.equal(cors.level, "warn");

  const listen = classify("0.00.149.953 I srv  llama_server: listening on http://127.0.0.1:8099");
  assert.equal(listen.kind, "listening");
  assert.equal(listen.level, "info");

  const err = classify("0.01.000.000 E srv  llama_server: 出问题了");
  assert.equal(err.kind, "error");
  assert.equal(err.level, "error");

  const list = classify("0.00.146.767 I srv    operator(): Available models (5) (*: custom preset)");
  assert.equal(list.kind, "model-list");

  // 旧版无前缀的日志仍然按关键词走
  const legacy = classify("main: server is listening on http://127.0.0.1:8080");
  assert.equal(legacy.kind, "listening");
});

test("诊断：显存不足优先于其它错误（都能刷出 error 字样）", () => {
  const d = diagnose([
    "error: failed to allocate buffer for kv cache",
    "CUDA error: out of memory",
    "main: couldn't bind HTTP server socket, port 8080 is already in use",
  ]);
  assert.equal(d?.code, "vram-oom");
  assert.ok((d?.suggestions.length ?? 0) >= 3, "必须给出可操作的下一步");
  assert.ok(d?.suggestions.some((s) => s.includes("--cache-type-k")));
});

test("诊断：端口占用 / presets 解析失败 / 找不到模型", () => {
  const port = diagnose(["main: couldn't bind HTTP server socket, port 8080 is already in use"]);
  assert.equal(port?.code, "port-in-use");
  assert.ok(port?.suggestions.some((s) => s.includes("端口")));

  const preset = diagnose(["error: failed to parse server config file from 'presets.ini'"]);
  assert.equal(preset?.code, "preset-parse");
  // 预设现在是启动器从配置渲染出来的，建议要指向配置里的 presets 字段
  assert.ok(preset?.suggestions.some((s) => s.includes("presets")), preset?.suggestions.join(" | "));

  const noModels = diagnose(["main: no models found in the models directory"]);
  assert.equal(noModels?.code, "no-models");
  assert.ok(noModels?.suggestions.some((s) => s.includes("presets")), noModels?.suggestions.join(" | "));

  const unsupported = diagnose(["error: option not recognized: --draft-type-k"]);
  assert.equal(unsupported?.code, "option-unsupported");
  assert.ok(unsupported?.suggestions.some((s) => s.includes("--spec-draft-type-k")));
});

test("诊断：草稿模型相关 / 正常启动日志不误报", () => {
  const draft = diagnose(["error: failed to load draft model for speculative decoding"]);
  assert.equal(draft?.code, "draft-model");
  assert.ok(draft?.suggestions.some((s) => s.includes("b10679")));

  assert.equal(diagnose(["main: server is listening on http://127.0.0.1:8080 - starting the main loop"]), null);
  assert.equal(diagnose([]), null);
});
