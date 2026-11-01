import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildPrecheckItems,
  compareVersions,
  isGgufFile,
  listBackends,
  majorOf,
  modelFileName,
  parseCudaRuntimeImports,
  parseDriverInfo,
  precheckWarnings,
  resolveDll,
} from "../core/precheck.ts";
import type { PrecheckFacts } from "../core/precheck.ts";
import { withTempDir } from "./helpers.ts";

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures");

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
    presetModelCount: 0,
    legacyPresetPath: "",
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

test("isGgufFile：只认大端 GGUF 头（临时文件，不依赖本机模型）", () => {
  withTempDir("llama-gguf-", (dir) => {
    const gguf = join(dir, "m.gguf");
    writeFileSync(gguf, Buffer.from("GGUF"));
    assert.equal(isGgufFile(gguf), true);

    const text = join(dir, "not-model.gguf");
    writeFileSync(text, "不是模型");
    assert.equal(isGgufFile(text), false);

    const short = join(dir, "short.gguf");
    writeFileSync(short, "GG");
    assert.equal(isGgufFile(short), false, "读不满 4 字节按不是 GGUF 处理");

    assert.equal(isGgufFile(join(dir, "没有这个文件.gguf")), null);
  });
});

test("listBackends：按 ggml-*.dll 归类，ggml-base 不算后端", () => {
  withTempDir("llama-backends-", (dir) => {
    for (const name of ["ggml-cpu.dll", "ggml-cpu-haswell.dll", "ggml-cuda.dll", "ggml-base.dll", "other.dll"]) {
      writeFileSync(join(dir, name), "");
    }
    const backends = listBackends(dir);
    assert.deepEqual(backends.sort(), ["cpu", "cuda"]);
    assert.equal(backends.includes("base"), false, "ggml-base 是公共库，不是后端");
  });
});

test("listBackends：目录不存在时返回空数组", () => {
  assert.deepEqual(listBackends(join(fixturesDir, "不存在的目录")), []);
});

test("resolveDll：按目录顺序查找", () => {
  const found = resolveDll("nvidia-smi-query.txt", [fixturesDir]);
  assert.equal(found, join(fixturesDir, "nvidia-smi-query.txt"));
  assert.equal(resolveDll("并不存在.dll", [fixturesDir]), null);
});

test("modelFileName：取文件名", () => {
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

test("端口被占用 → warn；预设情况的两种结果", () => {
  assert.equal(itemById(buildPrecheckItems(facts({ portFree: false })), "port")?.level, "warn");
  // 配了预设 → ok（并报出模型个数）
  const withPresets = itemById(buildPrecheckItems(facts({ presetModelCount: 5 })), "preset-models");
  assert.equal(withPresets?.level, "ok");
  assert.ok(withPresets?.title.includes("5"), withPresets?.title);
  // 只留了旧的 ini 路径、预设表还是空的 → warn 并指路「导入 presets.ini」
  const legacy = itemById(
    buildPrecheckItems(facts({ presetModelCount: 0, legacyPresetPath: "E:\\中文目录\\presets.ini" })),
    "preset-legacy",
  );
  assert.equal(legacy?.level, "warn");
  assert.ok(legacy?.suggestion?.includes("导入"), legacy?.suggestion);
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