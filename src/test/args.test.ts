import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildArgs, CHAT_TEMPLATE_KWARGS_ENV, describeSteps, formatArgv, splitCustomArgs } from "../core/args.ts";
import { createCapabilities } from "../core/helpProbe.ts";
import { DEFAULT_CONFIG } from "../core/config.ts";
import type { BuildInput, BuildResult, LauncherConfig } from "../core/types.ts";

const help = readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "help-b10488.txt"), "utf8");
const caps = createCapabilities(help);

/** 一份"典型 16G 显存跑 7B"的基线配置 */
function base(over: Partial<LauncherConfig> = {}): LauncherConfig {
  return {
    ...DEFAULT_CONFIG,
    llama_dir: "E:\\Code\\llama\\llama.cpp",
    mode: "single",
    main_model: "E:\\Code\\llama\\models\\qwen2.5-7b-instruct-q4_k_m.gguf",
    port: 8080,
    context: 16384,
    threads: 6,
    max_predict: 8192,
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
    presence_penalty: 1,
    repeat_penalty: null,
    kv_k_type: "q4_0",
    kv_v_type: "q4_0",
    flash_attention: true,
    gpu_layers: "auto",
    fit_target: 1024,
    load_mode: "mmap+mlock",
    jinja: true,
    think: "off",
    custom_args: "",
    ...over,
  };
}

function build(config: LauncherConfig, over: Partial<BuildInput> = {}): BuildResult {
  return buildArgs({ config, caps, ...over });
}

function pair(argv: readonly string[], flag: string): string[] {
  const i = argv.indexOf(flag);
  return i === -1 ? [] : argv.slice(i, i + 2);
}

// ---------------------------------------------------------------------------
const PRESET_KEYS = ["ctx-size", "cache-type-k", "cache-type-v", "fit-target", "load-mode", "threads", "temperature"];

test("single 模式：完整命令行（黄金用例，逐字节对拍）", () => {
  const r = build(base());
  assert.deepEqual(r.argv, [
    "--host", "127.0.0.1",
    "--port", "8080",
    "-m", "E:\\Code\\llama\\models\\qwen2.5-7b-instruct-q4_k_m.gguf",
    "-t", "6",
    "-c", "16384",
    "-n", "8192",
    "-fa", "on",
    "--cache-type-k", "q4_0",
    "--cache-type-v", "q4_0",
    "--jinja",
    "--reasoning", "off",
    "--temp", "0.7",
    "--top-p", "0.8",
    "--top-k", "20",
    "--min-p", "0",
    "--presence-penalty", "1",
    "--fit-target", "1024",
    "--load-mode", "mmap+mlock",
  ]);
  assert.deepEqual(r.warnings, [], `不该有告警：${r.warnings.join(" | ")}`);
  assert.deepEqual(r.env, {});
});

test("router 模式：preset 里定义过的键命令行不再传", () => {
  const r = build(
    base({
      mode: "router",
      main_model: undefined,
      models_dir: "E:\\Code\\llama\\models",
      models_preset: "E:\\Code\\llama\\presets.ini",
      models_max: 1,
    }),
    { presetKeys: PRESET_KEYS },
  );
  const has = (flag: string): boolean => r.argv.includes(flag);

  assert.deepEqual(pair(r.argv, "--models-dir"), ["--models-dir", "E:\\Code\\llama\\models"]);
  assert.deepEqual(pair(r.argv, "--models-preset"), ["--models-preset", "E:\\Code\\llama\\presets.ini"]);
  assert.deepEqual(pair(r.argv, "--models-max"), ["--models-max", "1"]);

  // preset 接管 → 命令行不能传（实测命令行优先级更高，会盖掉 preset）
  for (const flag of ["-c", "-t", "--cache-type-k", "--cache-type-v", "--fit-target", "--load-mode", "--temp"]) {
    assert.equal(has(flag), false, `${flag} 应由 preset 接管`);
  }
  // 没被 preset 接管的照旧由命令行传
  for (const flag of ["-n", "-fa", "--top-p", "--top-k"]) {
    assert.equal(has(flag), true, `${flag} 应仍由命令行传`);
  }

  assert.equal(r.steps.find((s) => s.key === "context")?.reason, "preset-owned");
  assert.equal(r.steps.find((s) => s.key === "temperature")?.reason, "preset-owned");
  assert.equal(r.steps.find((s) => s.key === "max_predict")?.reason, "cli");
});

test("预加载模式：preset 对该模型不生效，ctx/线程/KV/fit/load-mode 改由命令行直传", () => {
  const preloadFile = "E:\\Code\\llama\\models\\Qwen3.8-27B-Uncensored-IQ4_XS.gguf";
  const r = build(
    base({
      mode: "router",
      main_model: undefined,
      models_dir: "E:\\Code\\llama\\models",
      models_preset: "E:\\Code\\llama\\presets.ini",
      preload_model: "Qwen3.8-27B-Uncensored-IQ4_XS",
    }),
    { presetKeys: PRESET_KEYS, preloadModelFile: preloadFile, preloadCtxFromPreset: 16384 },
  );

  assert.deepEqual(pair(r.argv, "--model"), ["--model", preloadFile], "预加载要带上模型绝对路径");
  assert.deepEqual(pair(r.argv, "-c"), ["-c", "16384"], "ctx 取 presets.ini 里该模型段的值");
  assert.deepEqual(pair(r.argv, "-t"), ["-t", "6"]);
  for (const flag of ["--cache-type-k", "--cache-type-v", "--fit-target", "--load-mode"]) {
    assert.equal(r.argv.includes(flag), true, `${flag} 在预加载模式下必须 CLI 直传`);
  }
  assert.equal(r.steps.find((s) => s.key === "context")?.reason, "preload-override");
  assert.equal(r.argv.includes("--temp"), false, "采样参数没有 preloadBypass，仍由 preset 接管");
  assert.equal(r.steps.find((s) => s.key === "temperature")?.reason, "preset-owned");
});

test("未预加载时明确记录「首次请求才加载」", () => {
  const r = build(base({ mode: "router", main_model: undefined, models_dir: "E:\\Code\\llama\\models" }));
  assert.equal(r.argv.includes("--model"), false);
  assert.equal(r.steps.find((s) => s.key === "preload_model")?.reason, "skipped");
});

// ---------------------------------------------------------------------------
const oldHelp = [
  "----- common params -----",
  "",
  "-m,    --model FNAME                    model path to load",
  "-c,    --ctx-size N                     size of the prompt context (default: 0)",
  "-fa,   --flash-attn                     enable Flash Attention (default: enabled)",
  "-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM (default: 0)",
  "-t,    --threads N                      number of CPU threads (default: -1)",
  "--mlock                                force system to keep model in RAM",
].join("\n");

test("旧版本：-fa 是纯开关，不带值", () => {
  const r = build(base(), { caps: createCapabilities(oldHelp) });
  assert.equal(r.argv.includes("-fa"), true);
  const next = r.argv[r.argv.indexOf("-fa") + 1];
  assert.ok(
    next === undefined || !["on", "off", "auto"].includes(next),
    `无占位符的旧语法不能传 on/off/auto，实际后面跟了 ${next}`,
  );
  assert.equal(r.steps.find((s) => s.key === "flash_attention")?.reason, "cli");
});

test("无 --fit-target 时回退 -ngl 99 并明确告警（不静默变成纯 CPU）", () => {
  const r = build(base(), { caps: createCapabilities(oldHelp) });
  assert.deepEqual(pair(r.argv, "-ngl"), ["-ngl", "99"]);
  assert.equal(r.steps.find((s) => s.key === "gpu_layers")?.reason, "fallback");
  assert.ok(
    r.warnings.some((w) => w.includes("-ngl 99")),
    `应有回退告警：${r.warnings.join(" | ")}`,
  );
});

test("显式数字分层则直接传 -ngl", () => {
  const r = build(base({ gpu_layers: 33 }));
  assert.deepEqual(pair(r.argv, "-ngl"), ["-ngl", "33"]);
  assert.equal(r.argv.includes("--fit-target"), false, "手动分层时不再传 fit-target");
});

test("纯 CPU 模式不回退 -ngl 99", () => {
  const r = build(base(), { caps: createCapabilities(oldHelp), cpuOnly: true });
  assert.equal(r.argv.includes("-ngl"), false);
  assert.equal(r.steps.find((s) => s.key === "gpu_layers")?.reason, "skipped");
});

test("没有 --load-mode 时退回旧参数 --mlock", () => {
  const r = build(base({ load_mode: "mmap+mlock" }), { caps: createCapabilities(oldHelp) });
  assert.deepEqual(pair(r.argv, "--mlock"), ["--mlock"]);
  assert.equal(r.steps.find((s) => s.key === "load_mode")?.reason, "fallback");
  assert.ok(r.warnings.some((w) => w.includes("--mlock")));
});

// ---------------------------------------------------------------------------
const oldThinkHelp = [
  "----- common params -----",
  "",
  "-m,    --model FNAME                    model path to load",
  "--reasoning-budget N                    token budget for thinking (default: -1)",
  "--chat-template-kwargs STRING           sets additional params for the json template parser",
].join("\n");

test("新版本直接用 --reasoning on/off，不需要环境变量兜底", () => {
  const r = build(base({ think: "off" }));
  assert.deepEqual(pair(r.argv, "--reasoning"), ["--reasoning", "off"]);
  assert.equal(r.env[CHAT_TEMPLATE_KWARGS_ENV], undefined);

  const on = build(base({ think: "on" }));
  assert.deepEqual(pair(on.argv, "--reasoning"), ["--reasoning", "on"]);
});

test("旧版本关思考：--reasoning-budget 0 + 环境变量 kwargs 双管齐下", () => {
  const r = build(base({ think: "off" }), { caps: createCapabilities(oldThinkHelp) });
  assert.deepEqual(pair(r.argv, "--reasoning-budget"), ["--reasoning-budget", "0"]);
  assert.equal(r.env[CHAT_TEMPLATE_KWARGS_ENV], '{"enable_thinking":false}');
  assert.equal(r.steps.find((s) => s.key === "think")?.reason, "fallback");
});

test("旧版本开思考：预算 -1 + --reasoning-format auto", () => {
  const helpText = `${oldThinkHelp}\n--reasoning-format FORMAT               controls thought tags (default: none)`;
  const r = build(base({ think: "on" }), { caps: createCapabilities(helpText) });
  assert.deepEqual(pair(r.argv, "--reasoning-budget"), ["--reasoning-budget", "-1"]);
  assert.deepEqual(pair(r.argv, "--reasoning-format"), ["--reasoning-format", "auto"]);
  assert.equal(r.env[CHAT_TEMPLATE_KWARGS_ENV], '{"enable_thinking":true}');
});

test("保留思考内容：思考模式已传过 --reasoning-format 时不重复传", () => {
  const helpText = `${oldThinkHelp}
--reasoning-format FORMAT               controls thought tags (default: none)`;
  const withThinking = build(base({ think: "on", reasoning_preserve: true }), { caps: createCapabilities(helpText) });
  assert.equal(withThinking.argv.filter((a) => a === "--reasoning-format").length, 1);
  assert.equal(withThinking.steps.find((s) => s.key === "reasoning_preserve")?.reason, "skipped");

  const withoutThinking = build(base({ think: "off", reasoning_preserve: true }));
  assert.deepEqual(pair(withoutThinking.argv, "--reasoning-format"), ["--reasoning-format", "auto"]);
});

test("两个开关都没有的版本：明确告警要用户自己加 /no_think", () => {
  const r = build(base({ think: "off" }), {
    caps: createCapabilities("----- common params -----\n\n-m,    --model FNAME    model path to load\n"),
  });
  assert.equal(r.steps.find((s) => s.key === "think")?.reason, "unsupported");
  assert.ok(r.warnings.some((w) => w.includes("/no_think")));
});

// ---------------------------------------------------------------------------
const oldDraftHelp = [
  "----- common params -----",
  "",
  "-m,    --model FNAME                    model path to load",
  "--model-draft FNAME                     draft model for speculative decoding",
  "--draft-type-k TYPE                     KV cache data type for K for the draft model",
  "--draft-n N                             number of tokens to draft (default: 3)",
].join("\n");

test("参数改名：草稿相关参数在新旧版本各自命中正确的名字", () => {
  const draftPath = "E:\\Code\\llama\\models\\draft.gguf";
  const modern = build(base({ draft_model: draftPath, draft_type_k: "q4_0", draft_n: 2 }));
  assert.deepEqual(pair(modern.argv, "--spec-draft-model"), ["--spec-draft-model", draftPath]);
  assert.deepEqual(pair(modern.argv, "--spec-draft-type-k"), ["--spec-draft-type-k", "q4_0"]);
  assert.deepEqual(pair(modern.argv, "--spec-draft-n-max"), ["--spec-draft-n-max", "2"]);

  const legacy = build(
    base({ draft_model: draftPath, draft_type_k: "q4_0", draft_n: 2 }),
    { caps: createCapabilities(oldDraftHelp) },
  );
  assert.deepEqual(pair(legacy.argv, "--model-draft"), ["--model-draft", draftPath]);
  assert.deepEqual(pair(legacy.argv, "--draft-type-k"), ["--draft-type-k", "q4_0"]);
  assert.deepEqual(pair(legacy.argv, "--draft-n"), ["--draft-n", "2"]);
});

test("改名前后都没有的参数：报不支持并告警，绝不瞎传", () => {
  const r = build(base({ draft_type_k: "q4_0" }), {
    caps: createCapabilities("----- common params -----\n\n-m,    --model FNAME    model path to load\n"),
  });
  assert.equal(r.steps.find((s) => s.key === "draft_type_k")?.reason, "unsupported");
  assert.ok(r.warnings.some((w) => w.includes("草稿 K cache 量化")));
});

// ---------------------------------------------------------------------------
test("并发槽位 / 线程：-1、0 视为自动，不传", () => {
  assert.equal(build(base({ parallel: -1 })).argv.includes("-np"), false);
  assert.equal(build(base({ threads: 0 })).argv.includes("-t"), false);
  assert.deepEqual(pair(build(base({ parallel: 4 })).argv, "-np"), ["-np", "4"]);
});

test("开关类参数：默认是「开」的项，关掉时必须显式传 no/off", () => {
  // llama.cpp 里 --jinja 默认启用、-fa 默认 auto（通常等于开），
  // 所以"不传"等于"没关" —— 这是把三态参数做成开关后最容易犯的错
  const r = build(base({ jinja: false, flash_attention: false, metrics: true, tools_all: true, agent: true }));
  assert.deepEqual(pair(r.argv, "-fa"), ["-fa", "off"], "FA 关掉要显式 off，不能只是不传");
  assert.equal(r.argv.includes("--no-jinja"), true, "Jinja 关掉要传 --no-jinja");
  assert.equal(r.argv.includes("--jinja"), false);
  assert.deepEqual(pair(r.argv, "--tools"), ["--tools", "all"]);
  assert.deepEqual(pair(r.argv, "--agent"), ["--agent"]);
  assert.equal(r.argv.includes("--metrics"), true);
});

test("关掉默认开启的项时，若本版本没有对应形式就明确告警，不假装关掉了", () => {
  const r = build(base({ jinja: false }), { caps: createCapabilities(oldHelp) });
  assert.equal(r.argv.includes("--jinja"), false);
  assert.equal(r.steps.find((s) => s.key === "jinja")?.reason, "unsupported");
  assert.ok(r.warnings.some((w) => w.includes("no-jinja")), r.warnings.join(" | "));
});

test("YaRN 未开启时 rope 参数不传", () => {
  const off = build(base({ rope_scale: 4 }));
  assert.equal(off.argv.includes("--rope-scale"), false);
  assert.equal(off.steps.find((s) => s.key === "rope_scale")?.reason, "skipped");

  const on = build(base({ rope_scaling: "yarn", rope_scale: 4, yarn_orig_ctx: 32768, context: 131072 }));
  assert.deepEqual(pair(on.argv, "--rope-scaling"), ["--rope-scaling", "yarn"]);
  assert.deepEqual(pair(on.argv, "--rope-scale"), ["--rope-scale", "4"]);
  assert.deepEqual(pair(on.argv, "--yarn-orig-ctx"), ["--yarn-orig-ctx", "32768"]);
});

test("presets 路径含非 ASCII 且没预先 stage 时给出告警", () => {
  const r = build(
    base({ mode: "router", main_model: undefined, models_dir: "E:\\models", models_preset: "E:\\中文目录\\presets.ini" }),
    { presetKeys: [] },
  );
  assert.ok(r.warnings.some((w) => w.includes("非 ASCII")), r.warnings.join(" | "));
  // 调用方 stage 过之后用 stagePresetIfNonAscii 的返回值，告警消失
  const staged = build(
    base({ mode: "router", main_model: undefined, models_dir: "E:\\models", models_preset: "E:\\中文目录\\presets.ini" }),
    { presetKeys: [], presetArgPath: "C:\\Temp\\presets.ini" },
  );
  assert.equal(staged.argv.includes("E:\\中文目录\\presets.ini"), false);
  assert.equal(staged.warnings.some((w) => w.includes("非 ASCII")), false);
});

test("自定义参数原样追加在最后，支持引号", () => {
  const r = build(base({ custom_args: '--no-kv-offload --alias "my model"' }));
  assert.deepEqual(r.argv.slice(-3), ["--no-kv-offload", "--alias", "my model"]);
  assert.equal(r.steps.at(-1)?.key, "custom_args");
});

test("splitCustomArgs", () => {
  assert.deepEqual(splitCustomArgs('--a 1 --b "x y" --c'), ["--a", "1", "--b", "x y", "--c"]);
  assert.deepEqual(splitCustomArgs(""), []);
  assert.deepEqual(splitCustomArgs("   "), []);
  assert.deepEqual(splitCustomArgs("--threads-http 8"), ["--threads-http", "8"]);
});

test("formatArgv 给带空格的参数补引号", () => {
  assert.equal(formatArgv(["-m", "E:\\a b\\x.gguf", "--port", "8080"]), '-m "E:\\a b\\x.gguf" --port 8080');
});

test("参数决策表每个参数都有一行，且都能说明原因", () => {
  const r = build(base());
  const text = describeSteps(r.steps);
  assert.ok(text.includes("命令行直传"));
  assert.ok(text.includes("未配置"));
  for (const step of r.steps) {
    assert.ok(step.note.length > 0, `${step.key} 缺少原因说明`);
  }
  // 决策表能说清"为什么没传"
  assert.ok(text.includes("presets.ini") === false, "没有 preset 时不该提 preset");
});
