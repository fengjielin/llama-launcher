import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../core/config.ts";
import {
  buildPrecheckItems,
  compareVersions,
  isGgufFile,
  listBackends,
  majorOf,
  modelFileName,
  parseCudaRuntimeImports,
  parseDriverInfo,
  pickModelPath,
  precheckWarnings,
  resolveDll,
  runPrecheck,
} from "../core/precheck.ts";
import type { PrecheckFacts } from "../core/precheck.ts";
import type { LauncherConfig } from "../core/types.ts";

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures");
const llamaDir = join(import.meta.dirname, "..", "..", "..", "llama.cpp");
const realExe = join(llamaDir, "llama-server.exe");
const realModel = join(import.meta.dirname, "..", "..", "..", "models", "qwen2.5-7b-instruct-q4_k_m.gguf");

/** 造一份"一切正常"的事实，便于逐项改动来测各个分支 */
function facts(over: Partial<PrecheckFacts> = {}): PrecheckFacts {
  return {
    exe: "E:\\llama\\llama-server.exe",
    exeExists: true,
    coreDllMissing: [],
    backends: ["cpu", "cuda"],
    cudaRuntimeDlls: ["cudart64_12.dll", "cublas64_12.dll"],
    cudaRequiredMajor: 12,
    needsDriver: true,
    missingRuntimeDlls: [],
    driverVersion: "566.36",
    driverMaxCuda: "12.7",
    gpuName: "NVIDIA GeForce RTX 4060 Ti",
    vramTotalMiB: 16380,
    modelPath: "E:\\models\\m.gguf",
    modelSizeMiB: 4096,
    modelMagicOk: true,
    portFree: true,
    presetPathNonAscii: false,
    ...over,
  };
}

/** 取某一项结论 */
function itemById(items: ReturnType<typeof buildPrecheckItems>, id: string): ReturnType<typeof buildPrecheckItems>[number] | undefined {
  return items.find((item) => item.id === id);
}

// ---------------------------------------------------------------------------
// 解析类
// ---------------------------------------------------------------------------

test("parseDriverInfo：解析真实 nvidia-smi 头部", () => {
  const header = readFileSync(join(fixturesDir, "nvidia-smi-header.txt"), "utf8");
  const info = parseDriverInfo(header);
  assert.equal(info.driverVersion, "566.36");
  assert.equal(info.maxCudaVersion, "12.7");
});

test("parseDriverInfo：读不到时返回 null 而不是猜", () => {
  assert.deepEqual(parseDriverInfo(""), { driverVersion: null, maxCudaVersion: null });
  assert.deepEqual(parseDriverInfo("nvidia-smi: command not found"), {
    driverVersion: null,
    maxCudaVersion: null,
  });
});

test("parseCudaRuntimeImports：CUDA 12 构建", () => {
  const result = parseCudaRuntimeImports([
    "ggml-base.dll",
    "cudart64_12.dll",
    "cublas64_12.dll",
    "nvcuda.dll",
    "KERNEL32.dll",
  ]);
  assert.equal(result.cudaMajor, 12);
  assert.deepEqual(result.runtimeDlls, ["cudart64_12.dll", "cublas64_12.dll"]);
  assert.equal(result.needsDriver, true);
});

test("parseCudaRuntimeImports：CUDA 13 构建", () => {
  const result = parseCudaRuntimeImports(["cudart64_13.dll", "cublas64_13.dll", "nvcuda.dll"]);
  assert.equal(result.cudaMajor, 13);
});

test("parseCudaRuntimeImports：nvrtc 的连写版本号要归一化（nvrtc64_120_0 → 12）", () => {
  const result = parseCudaRuntimeImports(["nvrtc64_120_0.dll"]);
  assert.equal(result.cudaMajor, 12);
});

test("parseCudaRuntimeImports：多个运行库取最大版本（保守）", () => {
  assert.equal(parseCudaRuntimeImports(["cudart64_12.dll", "cublas64_13.dll"]).cudaMajor, 13);
});

test("parseCudaRuntimeImports：没有 CUDA 时为 null", () => {
  const result = parseCudaRuntimeImports(["ggml-base.dll", "KERNEL32.dll"]);
  assert.equal(result.cudaMajor, null);
  assert.deepEqual(result.runtimeDlls, []);
  assert.equal(result.needsDriver, false);
});

test("compareVersions / majorOf", () => {
  assert.ok((compareVersions("12.7", "12.4") ?? 0) > 0);
  assert.ok((compareVersions("12.4", "12.7") ?? 0) < 0);
  assert.equal(compareVersions("12.7", "12.7"), 0);
  assert.equal(compareVersions("13", "12.7"), 1);
  assert.equal(compareVersions("abc", "12"), null);

  assert.equal(majorOf("12.7"), 12);
  assert.equal(majorOf("13"), 13);
  assert.equal(majorOf("abc"), null);
});

test("isGgufFile：真实模型是 GGUF；文本文件不是；不存在返回 null", { skip: existsSync(realModel) ? false : "本机没有该模型，跳过" }, () => {
  assert.equal(isGgufFile(realModel), true);
  assert.equal(isGgufFile(join(fixturesDir, "help-b10488.txt")), false);
  assert.equal(isGgufFile(join(fixturesDir, "没有这个文件.gguf")), null);
});

test("listBackends：从真实目录里认出 cpu 与 cuda", { skip: existsSync(llamaDir) ? false : "本机没有 llama.cpp 目录，跳过" }, () => {
  const backends = listBackends(llamaDir);
  assert.ok(backends.includes("cpu"), `实际：${backends.join(", ")}`);
  assert.ok(backends.includes("cuda"));
  // ggml-base.dll 不是后端，不该被算进去
  assert.equal(backends.includes("base"), false);
});

test("listBackends：目录不存在时返回空数组", () => {
  assert.deepEqual(listBackends(join(fixturesDir, "不存在的目录")), []);
});

test("resolveDll：按目录顺序查找", () => {
  const found = resolveDll("nvidia-smi-query.txt", [fixturesDir]);
  assert.equal(found, join(fixturesDir, "nvidia-smi-query.txt"));
  assert.equal(resolveDll("并不存在.dll", [fixturesDir]), null);
});

test("pickModelPath：router 取预加载模型，single 取主模型", () => {
  assert.equal(
    pickModelPath({ ...DEFAULT_CONFIG, mode: "router", models_dir: "E:\\m", preload_model: "abc" }),
    join("E:\\m", "abc.gguf"),
  );
  assert.equal(pickModelPath({ ...DEFAULT_CONFIG, mode: "router", models_dir: "E:\\m" }), null);
  assert.equal(pickModelPath({ ...DEFAULT_CONFIG, mode: "single", main_model: "E:\\x.gguf" }), "E:\\x.gguf");
  assert.equal(pickModelPath({ ...DEFAULT_CONFIG, mode: "single" }), null);
  assert.equal(modelFileName("E:\\m\\x.gguf"), "x.gguf");
});

// ---------------------------------------------------------------------------
// 结论生成（纯逻辑，逐分支覆盖）
// ---------------------------------------------------------------------------

test("一切正常：总评为 ok，且包含驱动兼容这条", () => {
  const items = buildPrecheckItems(facts());
  const verdict = items.reduce((worst, item) => (item.level === "error" ? "error" : worst), "ok");
  assert.equal(verdict, "ok");
  assert.equal(itemById(items, "cuda-driver")?.level, "ok");
  assert.match(itemById(items, "cuda-driver")?.title ?? "", /驱动支持 CUDA 12\.7/);
  assert.equal(itemById(items, "model-vram")?.level, "ok");
});

test("驱动太旧：CUDA 13 构建 + 驱动只到 12.7 → error，并给出两条出路", () => {
  const items = buildPrecheckItems(facts({ cudaRequiredMajor: 13, cudaRuntimeDlls: ["cudart64_13.dll"] }));
  const driver = itemById(items, "cuda-driver");
  assert.equal(driver?.level, "error");
  assert.match(driver?.title ?? "", /驱动太旧/);
  assert.match(driver?.suggestion ?? "", /580/);
  assert.match(driver?.suggestion ?? "", /CUDA 12/);
});

test("CUDA 12.4 构建 + 驱动支持 12.7 → 明确说没问题（这就是本机的情况）", () => {
  const driver = itemById(buildPrecheckItems(facts()), "cuda-driver");
  assert.equal(driver?.level, "ok");
  assert.match(driver?.detail ?? "", /同一大版本内向下兼容/);
});

test("缺核心 DLL / 缺运行时 DLL / exe 不存在 → error", () => {
  assert.equal(itemById(buildPrecheckItems(facts({ coreDllMissing: ["llama.dll"] })), "core-dll")?.level, "error");
  assert.equal(
    itemById(buildPrecheckItems(facts({ missingRuntimeDlls: ["cudart64_12.dll"] })), "runtime-dll")?.level,
    "error",
  );
  const noExe = buildPrecheckItems(facts({ exeExists: false }));
  assert.equal(noExe.length, 1, "exe 都没有时不必再报后面那些");
  assert.equal(noExe[0]?.level, "error");
});

test("模型下坏了（开头不是 GGUF）→ error", () => {
  const item = itemById(buildPrecheckItems(facts({ modelMagicOk: false })), "model");
  assert.equal(item?.level, "error");
  assert.match(item?.title ?? "", /不是 GGUF/);
});

test("模型超过显存 → warn 并给出可执行建议（27B 挤 16G 即此情形）", () => {
  // 14.26 GB 的 IQ4_XS 挤 16 GB 卡：权重占 87%，KV cache 一定放不下
  const item = itemById(buildPrecheckItems(facts({ modelSizeMiB: 14600, vramTotalMiB: 16380 })), "model-vram");
  assert.equal(item?.level, "warn");
  assert.match(item?.title ?? "", /KV cache 放不下/);
  assert.match(item?.suggestion ?? "", /--n-cpu-moe|IQ2_M/);

  // 权重本身就超过显存：措辞要不一样
  const bigger = itemById(buildPrecheckItems(facts({ modelSizeMiB: 17200, vramTotalMiB: 16380 })), "model-vram");
  assert.equal(bigger?.level, "warn");
  assert.match(bigger?.title ?? "", /已超过显存/);
});

test("模型占到 60%~85% → info 提醒余量", () => {
  const item = itemById(buildPrecheckItems(facts({ modelSizeMiB: 12000, vramTotalMiB: 16380 })), "model-vram");
  assert.equal(item?.level, "info");
});

test("小模型 → ok", () => {
  const item = itemById(buildPrecheckItems(facts({ modelSizeMiB: 4600, vramTotalMiB: 16380 })), "model-vram");
  assert.equal(item?.level, "ok");
  assert.match(item?.title ?? "", /余量充足/);
});

test("端口被占用 → warn；presets 路径含中文 → warn", () => {
  assert.equal(itemById(buildPrecheckItems(facts({ portFree: false })), "port")?.level, "warn");
  assert.equal(itemById(buildPrecheckItems(facts({ presetPathNonAscii: true })), "preset-path")?.level, "warn");
});

test("没有 CUDA 后端 → info 并提示换发行包", () => {
  const item = itemById(
    buildPrecheckItems(facts({ backends: ["cpu"], cudaRequiredMajor: null, cudaRuntimeDlls: [], needsDriver: false })),
    "backends",
  );
  assert.equal(item?.level, "info");
  assert.match(item?.suggestion ?? "", /ggml-cuda\.dll/);
});

test("需要驱动但没显卡 → warn", () => {
  const items = buildPrecheckItems(
    facts({ backends: ["cpu", "cuda"], cudaRequiredMajor: null, gpuName: null, driverMaxCuda: null, driverVersion: null }),
  );
  assert.equal(itemById(items, "cuda-driver")?.level, "warn");
});

test("precheckWarnings 只挑 error/warn 并带上建议", () => {
  const report = {
    at: 0,
    verdict: "warn" as const,
    items: buildPrecheckItems(facts({ portFree: false, modelMagicOk: false })),
    facts: facts({ portFree: false, modelMagicOk: false }),
  };
  const warnings = precheckWarnings(report);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((line) => line.startsWith("[环境自检]")));
  assert.ok(warnings.some((line) => line.includes("端口")));
});

// ---------------------------------------------------------------------------
// 整体跑一遍（用本机真实环境）
// ---------------------------------------------------------------------------

test(
  "runPrecheck：在本机真实环境跑通，且能读出「构建需要 CUDA 12 / 驱动支持 12.7」",
  { skip: existsSync(realExe) ? false : "本机没有 llama.cpp，跳过" },
  async () => {
    const config: LauncherConfig = {
      ...DEFAULT_CONFIG,
      llama_dir: llamaDir,
      mode: "single",
      main_model: existsSync(realModel) ? realModel : "",
    };

    const report = await runPrecheck({ config, exe: realExe });

    assert.equal(report.facts.exeExists, true);
    assert.equal(report.facts.cudaRequiredMajor, 12, "b10488 是 CUDA 12.4 构建");
    assert.match(report.facts.driverMaxCuda ?? "", /^\d+\.\d+$/);
    assert.ok(report.facts.backends.includes("cuda"));
    assert.ok(report.items.length >= 5);
    // 本机环境是匹配的，不该出现 error
    const errors = report.items.filter((item) => item.level === "error");
    assert.deepEqual(
      errors.map((item) => `${item.id}: ${item.title}`),
      [],
    );
    assert.ok(["ok", "info", "warn"].includes(report.verdict));
  },
);
