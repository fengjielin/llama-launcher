/**
 * 环境自检：在点「启动」之前，把「这份构建 + 这台机器」的匹配情况查一遍。
 *
 * 为什么值得做：llama.cpp 的启动失败里有一大类不是配置问题，而是环境对不上 ——
 * 驱动太旧跑不了这个 CUDA 构建、缺 CUDA 运行时 DLL、模型没下完、显存装不下。
 * 这些在点下去之前全都能查出来，而点下去之后只能对着 llama-server 的报错猜。
 *
 * 关键判断依据（实测，不是猜的）：
 * - **这份构建需要哪个 CUDA** ← `ggml-cuda.dll` 的 PE 导入表。
 *   b10488 的 CUDA 12.4 构建导入的是 `cudart64_12.dll` / `cublas64_12.dll` / `nvcuda.dll`；
 *   CUDA 13 构建则是 `..._13.dll`。这是离线唯一可靠的依据。
 * - **驱动支持的 CUDA 上限** ← `nvidia-smi` 头部那行 `CUDA Version: 12.7`
 *   （本机驱动 566.36 → 12.7，跑 CUDA 12.4 构建没问题）
 * - CUDA 的兼容规则：**同一大版本内向下兼容**（支持 12.7 的驱动能跑任何 12.x 构建），
 *   跨大版本则要求驱动不低于构建所需的大版本。
 *
 * 自检**只提示、不拦截**：误判的代价（用户被挡住）比漏判（用户看到一条警告）大得多。
 */

import { existsSync, openSync, closeSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { queryGpus } from "./gpu.ts";
import type { GpuQueryResult } from "./gpu.ts";
import { probeTcp } from "./health.ts";
import { runCapture } from "./llamaProcess.ts";
import { hasNonAsciiPath } from "./presets.ts";
import { readPeImports } from "./pe.ts";
import type { PeImports } from "./pe.ts";
import type { LauncherConfig } from "./types.ts";

/** 自检结论的级别；`error` 表示"这样启动基本一定会失败" */
export type PrecheckLevel = "ok" | "info" | "warn" | "error";

/** 一条自检结论 */
export interface PrecheckItem {
  /** 稳定的机器可读标识（界面用它做 key 与去重） */
  id: string;
  level: PrecheckLevel;
  /** 一句话结论 */
  title: string;
  /** 支撑这个结论的事实 */
  detail: string;
  /** 该怎么做（可执行建议） */
  suggestion?: string;
}

/** 采集到的环境事实；界面可直接展示，排查时也一目了然 */
export interface PrecheckFacts {
  /** 被检查的 llama-server.exe 路径 */
  exe: string;
  exeExists: boolean;
  /** 缺少的核心 DLL（llama.dll / ggml.dll / ggml-base.dll） */
  coreDllMissing: string[];
  /** 构建包含的后端家族，如 `["cpu", "cuda"]` */
  backends: string[];
  /** `ggml-cuda.dll` 的导入表中出现的 CUDA 运行库（如 `cudart64_12.dll`） */
  cudaRuntimeDlls: string[];
  /** 从导入表推出的 CUDA 大版本（12 / 13）；没有 CUDA 后端时为 `null` */
  cudaRequiredMajor: number | null;
  /** 构建是否需要 NVIDIA 驱动（导入表里有 `nvcuda.dll`） */
  needsDriver: boolean;
  /** 解析不到的运行时 DLL（会在启动时弹"找不到 DLL"） */
  missingRuntimeDlls: string[];
  driverVersion: string | null;
  /** 驱动支持的 CUDA 上限，来自 nvidia-smi 头部 */
  driverMaxCuda: string | null;
  gpuName: string | null;
  vramTotalMiB: number | null;
  /** 主模型（或预加载模型）的绝对路径 */
  modelPath: string | null;
  modelSizeMiB: number | null;
  /** 模型开头是否是 GGUF 魔数；读不到时为 `null` */
  modelMagicOk: boolean | null;
  /** 配置里的监听端口是否空闲；无法判断时为 `null` */
  portFree: boolean | null;
  /** presets.ini 路径是否含非 ASCII 字符 */
  presetPathNonAscii: boolean;
}

/** 自检报告 */
export interface PrecheckReport {
  /** 生成时间戳（毫秒） */
  at: number;
  /** 最严重的那一项的级别 */
  verdict: PrecheckLevel;
  items: PrecheckItem[];
  facts: PrecheckFacts;
}

/** 需要随 exe 一起存在的核心 DLL（缺了 llama-server 直接起不来） */
const CORE_DLLS: readonly string[] = ["llama.dll", "ggml.dll", "ggml-base.dll"];

/**
 * CUDA 运行库的命名模式。
 *
 * 覆盖实测会遇到的写法：
 * - `cudart64_12.dll` / `cublas64_12.dll` / `cublasLt64_12.dll`（CUDA 12 构建）
 * - `cudart64_13.dll`（CUDA 13 构建）
 * - `nvrtc64_120_0.dll`：nvrtc 的版本号是**连写**的，后面还可能跟一个子版本（`_0`）
 */
const CUDA_RUNTIME_RE = /^(cudart|cublas|cublasLt|nvrtc|nvJitLink)[A-Za-z0-9]*?_(\d+)(?:_\d+)?\.dll$/i;

/** GGUF 文件的魔数（ASCII `GGUF`，按大端解释：0x47475546） */
const GGUF_MAGIC = 0x47475546;

/**
 * 从 `nvidia-smi` 的头部文本里读出驱动版本与驱动支持的 CUDA 上限。
 *
 * 实测目标行：
 *   `| NVIDIA-SMI 566.36                 Driver Version: 566.36         CUDA Version: 12.7     |`
 *
 * @param text `nvidia-smi` 的头部输出（前几行就够）
 * @returns `driverVersion` 与 `maxCudaVersion`，读不到则为 `null`（不抛异常、不猜）
 */
export function parseDriverInfo(text: string): { driverVersion: string | null; maxCudaVersion: string | null } {
  const driver = /Driver Version:\s*([0-9]+(?:\.[0-9]+)*)/i.exec(text);
  const cuda = /CUDA Version:\s*([0-9]+(?:\.[0-9]+)*)/i.exec(text);
  return {
    driverVersion: driver?.[1] ?? null,
    maxCudaVersion: cuda?.[1] ?? null,
  };
}

/**
 * 从导入表里挑出 CUDA 运行库，并推断构建所需的 CUDA 大版本。
 *
 * 多个运行库都带版本号时取**最大值**（保守：以要求最高的为准）。
 *
 * @param imports PE 导入表里的 DLL 名
 * @returns 所需 CUDA 大版本、涉及到的运行库名、是否需要 NVIDIA 驱动
 */
export function parseCudaRuntimeImports(imports: readonly string[]): {
  cudaMajor: number | null;
  runtimeDlls: string[];
  needsDriver: boolean;
} {
  const runtimeDlls: string[] = [];
  let cudaMajor: number | null = null;
  let needsDriver = false;

  for (const dll of imports) {
    const matched = CUDA_RUNTIME_RE.exec(dll);
    if (matched?.[2] !== undefined) {
      runtimeDlls.push(dll);
      const major = Number.parseInt(matched[2], 10);
      // nvrtc 的命名是 nvrtc64_120_0.dll，第一段数字是 120 这种连写形式，
      // 只取大版本号的前 2 位才有意义（120 → 12）
      const normalized = matched[1]?.toLowerCase() === "nvrtc" && major > 99 ? Math.floor(major / 10) : major;
      if (Number.isFinite(normalized)) cudaMajor = cudaMajor === null ? normalized : Math.max(cudaMajor, normalized);
    }
    if (/^nvcuda\.dll$/i.test(dll)) needsDriver = true;
  }

  return { cudaMajor, runtimeDlls, needsDriver };
}

/**
 * 比较两个版本号字符串（逐段按数字比）。
 *
 * @param a 版本号，如 `12.7`
 * @param b 版本号，如 `12.4`
 * @returns `a > b` 返回正数、相等返回 0、`a < b` 返回负数；任一方无法解析时返回 `null`
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string): number[] | null => {
    const parts = value.split(".").map((piece) => Number.parseInt(piece, 10));
    return parts.length > 0 && parts.every((n) => Number.isFinite(n)) ? parts : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return null;

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 取版本号的第一个数字段（`12.7` → 12）。
 *
 * @param version 版本号字符串
 * @returns 大版本号；解析不出返回 `null`
 */
export function majorOf(version: string): number | null {
  const parsed = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 在给定目录列表里找一个 DLL（模拟 Windows 的 DLL 搜索顺序里的"exe 同目录 → PATH"）。
 *
 * @param name DLL 文件名，如 `cudart64_12.dll`
 * @param dirs 搜索目录，按优先级排列
 * @returns 命中的完整路径；都没找到返回 `null`
 */
export function resolveDll(name: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // 某些目录可能不可访问，跳过继续找
    }
  }
  return null;
}

/**
 * 列出构建里包含的后端家族。
 *
 * 依据是 exe 同目录下的 `ggml-*.dll`：`ggml-cpu-haswell.dll` → `cpu`、`ggml-cuda.dll` → `cuda`。
 * 只看文件名，不加载 DLL。
 *
 * @param dir llama.cpp 目录
 * @returns 去重后的后端名（如 `["cpu", "cuda", "rpc"]`）；目录读不到时返回空数组
 */
export function listBackends(dir: string): string[] {
  const families = new Set<string>();
  try {
    for (const entry of readdirSync(dir)) {
      const matched = /^ggml-([a-z0-9]+)(?:-[a-z0-9]+)*\.dll$/i.exec(entry);
      if (matched?.[1] !== undefined && matched[1] !== "base") families.add(matched[1].toLowerCase());
    }
  } catch {
    // 目录不可读时按"没有后端信息"处理
  }
  return [...families];
}

/**
 * 读文件开头的 4 字节并判断是否是 GGUF。
 *
 * 只读 4 字节（模型动辄十几 GB，绝不能整读）。
 * 注意按**大端**解释：文件里就是 ASCII 的 `GGUF`（0x47 0x47 0x55 0x46），
 * 用 `readUInt32LE` 会得到 0x46554747 而对不上（踩过这个坑，单测抓出来的）。
 *
 * @param path 文件路径
 * @returns 是 GGUF 返回 `true`，不是返回 `false`，读不到返回 `null`
 */
export function isGgufFile(path: string): boolean | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(4);
    const read = readSync(fd, header, 0, 4, 0);
    if (read < 4) return false;
    return header.readUInt32BE(0) === GGUF_MAGIC;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭失败
      }
    }
  }
}

/**
 * 根据采集到的事实生成自检结论（纯函数，便于把所有分支都测一遍）。
 *
 * @param facts 环境事实
 * @returns 结论列表（顺序即展示顺序）
 */
export function buildPrecheckItems(facts: PrecheckFacts): PrecheckItem[] {
  const items: PrecheckItem[] = [];

  // ---- 1. 可执行文件本身 ----
  if (!facts.exeExists) {
    items.push({
      id: "exe",
      level: "error",
      title: "找不到 llama-server.exe",
      detail: facts.exe,
      suggestion: "在左侧「构建目录」里指定正确的 llama.cpp 目录（要有 llama-server.exe 与它旁边的 DLL）。",
    });
    return items;
  }
  items.push({ id: "exe", level: "ok", title: "可执行文件已就位", detail: facts.exe });

  // ---- 2. 核心 DLL ----
  if (facts.coreDllMissing.length > 0) {
    items.push({
      id: "core-dll",
      level: "error",
      title: `缺少核心 DLL：${facts.coreDllMissing.join("、")}`,
      detail: "llama.cpp 的 Windows 发行包是 exe + 一堆 DLL 一起用的，只拷 exe 起不来。",
      suggestion: "把整个发行包解压到同一目录（不要只挑 exe）。",
    });
  } else {
    items.push({ id: "core-dll", level: "ok", title: "核心 DLL 齐全", detail: CORE_DLLS.join("、") });
  }

  // ---- 3. 后端构成 ----
  const hasCuda = facts.backends.includes("cuda") || facts.cudaRequiredMajor !== null;
  items.push({
    id: "backends",
    level: "info",
    title: hasCuda ? "构建包含 CUDA 后端" : "构建没有 CUDA 后端",
    detail: `检测到的后端：${facts.backends.length > 0 ? facts.backends.join("、") : "（无 ggml-*.dll）"}${
      hasCuda ? `；需要的 CUDA 运行库：${facts.cudaRuntimeDlls.join("、") || "未知"}` : ""
    }`,
    suggestion: hasCuda ? undefined : "这个构建只能用 CPU 推理。要用显卡请换带 ggml-cuda.dll 的发行包。",
  });

  // ---- 4. 驱动能力 vs 构建所需的 CUDA（本次的核心检查）----
  if (facts.cudaRequiredMajor !== null) {
    const driverMajor = facts.driverMaxCuda === null ? null : majorOf(facts.driverMaxCuda);
    if (facts.driverMaxCuda === null || driverMajor === null) {
      items.push({
        id: "cuda-driver",
        level: "info",
        title: "无法确认驱动支持的 CUDA 版本",
        detail: facts.driverVersion === null ? "nvidia-smi 不可用，读不到驱动信息。" : `驱动 ${facts.driverVersion}。`,
        suggestion: "装好 NVIDIA 驱动后重跑自检；若已装好但仍读不到，检查 nvidia-smi 是否在 PATH 上。",
      });
    } else if (driverMajor < facts.cudaRequiredMajor) {
      items.push({
        id: "cuda-driver",
        level: "error",
        title: `驱动太旧：构建需要 CUDA ${facts.cudaRequiredMajor}，驱动只支持到 CUDA ${facts.driverMaxCuda}`,
        detail: `驱动 ${facts.driverVersion} 的最高 CUDA 版本是 ${facts.driverMaxCuda}；这份构建链接的是 ${
          facts.cudaRuntimeDlls.join("、") || `CUDA ${facts.cudaRequiredMajor} 运行库`
        }。跨大版本不兼容，启动时 CUDA 初始化会直接失败。`,
        suggestion:
          facts.cudaRequiredMajor >= 13
            ? "两个选择：① 把显卡驱动升级到 580 或更高；② 换用 CUDA 12 的 llama.cpp 发行包（例如 llama-b*-bin-win-cuda-12.4-x64.zip）。"
            : "把显卡驱动升级到支持该 CUDA 版本的版本，或换用更低 CUDA 版本的发行包。",
      });
    } else {
      items.push({
        id: "cuda-driver",
        level: "ok",
        title: `驱动可以运行这份构建（驱动支持 CUDA ${facts.driverMaxCuda}，构建需要 CUDA ${facts.cudaRequiredMajor}）`,
        detail: `驱动版本 ${facts.driverVersion}。同一大版本内向下兼容，所以 CUDA ${facts.cudaRequiredMajor}.x 的构建没问题。`,
      });
    }
  } else if (hasCuda && facts.needsDriver && facts.gpuName === null) {
    items.push({
      id: "cuda-driver",
      level: "warn",
      title: "构建需要 NVIDIA 驱动，但没检测到显卡",
      detail: "ggml-cuda.dll 依赖 nvcuda.dll（由驱动提供），没有 NVIDIA 显卡时 CUDA 后端会初始化失败。",
      suggestion: "确认显卡与驱动正常；或改用纯 CPU / 其它后端的发行包。",
    });
  }

  // ---- 5. 运行时 DLL 能不能解析到 ----
  if (facts.missingRuntimeDlls.length > 0) {
    items.push({
      id: "runtime-dll",
      level: "error",
      title: `缺少 CUDA 运行时：${facts.missingRuntimeDlls.join("、")}`,
      detail: "这些 DLL 既不在 llama.cpp 目录里，也不在 PATH 上。启动时 Windows 会弹「找不到 xxx.dll」并直接失败。",
      suggestion:
        "装对应的 CUDA Runtime（本机是 CUDA 12.4），或从 llama.cpp 发布的 cudart-llama-bin-win-cuda-*.zip 里取 DLL 放到 llama.cpp 目录。",
    });
  } else if (facts.cudaRuntimeDlls.length > 0) {
    items.push({
      id: "runtime-dll",
      level: "ok",
      title: "CUDA 运行时 DLL 都能找到",
      detail: facts.cudaRuntimeDlls.join("、"),
    });
  }

  // ---- 6. 显卡与显存 ----
  if (facts.gpuName !== null) {
    items.push({
      id: "gpu",
      level: "ok",
      title: `显卡：${facts.gpuName}`,
      detail: facts.vramTotalMiB === null ? "显存总量未知" : `显存 ${(facts.vramTotalMiB / 1024).toFixed(1)} GB`,
    });
  }

  // ---- 7. 模型文件：存在、是 GGUF、装不装得下 ----
  if (facts.modelPath !== null) {
    if (facts.modelMagicOk === null) {
      items.push({
        id: "model",
        level: "error",
        title: "模型文件打不开",
        detail: facts.modelPath,
        suggestion: "检查路径与文件权限。",
      });
    } else if (facts.modelMagicOk === false) {
      items.push({
        id: "model",
        level: "error",
        title: "模型文件不是 GGUF",
        detail: `${facts.modelPath} 的开头不是 GGUF 魔数，通常是没下完、下成了网页（HTML）或分片没合并。`,
        suggestion: "重新下载；分片模型要用 llama-gguf-split --merge 合并后再用。",
      });
    } else if (facts.modelSizeMiB !== null && facts.vramTotalMiB !== null && facts.vramTotalMiB > 0) {
      const ratio = facts.modelSizeMiB / facts.vramTotalMiB;
      const modelGb = (facts.modelSizeMiB / 1024).toFixed(1);
      const vramGb = (facts.vramTotalMiB / 1024).toFixed(1);
      const percent = Math.round(ratio * 100);
      if (ratio >= 1) {
        items.push({
          id: "model-vram",
          level: "warn",
          title: `模型 ${modelGb} GB 已超过显存 ${vramGb} GB`,
          detail: "llama.cpp 会按 --fit 自动把放不下的层留在内存，速度会明显下降。",
          suggestion:
            "换更小的量化（如 IQ2_M 约 9.9 GB）、把 MoE 专家权重放内存（--n-cpu-moe）、调小 ctx，或降低 --fit-target 让更多层上卡。",
        });
      } else if (ratio > 0.85) {
        // 阈值取 0.85 的由来：模型权重之外还要放 KV cache 与计算缓冲，
        // 权重占到 85% 以上时 KV 基本一定放不下 —— 27B IQ4_XS（14.3 GB）挤 16 GB 卡正是这种情形。
        items.push({
          id: "model-vram",
          level: "warn",
          title: `模型 ${modelGb} GB 已占显存 ${vramGb} GB 的 ${percent}%，KV cache 放不下`,
          detail: "部分层会被 --fit 自动留在内存里，实测这类配置生成速度会掉到个位数 tok/s。",
          suggestion:
            "换更小的量化（IQ2_M 约 9.9 GB）、把 MoE 专家权重放内存（--n-cpu-moe）、调小 ctx，或降低 --fit-target 让更多层上卡。",
        });
      } else if (ratio > 0.6) {
        items.push({
          id: "model-vram",
          level: "info",
          title: `模型 ${modelGb} GB 占显存 ${vramGb} GB 的 ${percent}%`,
          detail: "还要加上 KV cache 与上下文开销，注意别贴太满。",
          suggestion: "KV 量化用 q4_0（本配置默认已是），并把 ctx 控制在需要的范围内。",
        });
      } else {
        items.push({
          id: "model-vram",
          level: "ok",
          title: `模型 ${modelGb} GB，显存 ${vramGb} GB，余量充足`,
          detail: `占用约 ${percent}%`,
        });
      }
    }
  } else {
    items.push({
      id: "model",
      level: "info",
      title: "没有指定主模型",
      detail: "router 模式下可以留空，首次请求时再按模型名加载。",
    });
  }

  // ---- 8. 端口 ----
  if (facts.portFree === false) {
    items.push({
      id: "port",
      level: "warn",
      title: "配置的端口已被占用",
      detail: "启动时启动器会自动往后找空闲端口，并在日志里说明改用了哪个。",
      suggestion: "如果想固定端口，先腾出它；否则不用管。",
    });
  } else if (facts.portFree === true) {
    items.push({ id: "port", level: "ok", title: "端口空闲", detail: "可以直接监听" });
  }

  // ---- 9. presets 路径 ----
  if (facts.presetPathNonAscii) {
    items.push({
      id: "preset-path",
      level: "warn",
      title: "presets.ini 路径含非 ASCII 字符",
      detail: "实测 llama-server 传非 ASCII 的 --models-preset 路径会直接崩退。",
      suggestion: "启动器会自动把它拷到临时目录再传，所以能跑；想彻底干净就把 presets.ini 放到纯英文路径下。",
    });
  }

  return items;
}

/**
 * 取级别的严重程度（用于算总评）。
 *
 * @param level 级别
 * @returns 数值越大越严重
 */
function severityOf(level: PrecheckLevel): number {
  switch (level) {
    case "error":
      return 3;
    case "warn":
      return 2;
    case "info":
      return 1;
    default:
      return 0;
  }
}

/** {@link runPrecheck} 的入参 */
export interface PrecheckInput {
  config: LauncherConfig;
  /** 已经解析好的 llama-server.exe 路径 */
  exe: string;
  /** 注入 GPU 查询（单测用；默认走 nvidia-smi） */
  queryGpus?: () => Promise<GpuQueryResult>;
  /** 注入 PATH 搜索目录（单测用；默认取 process.env.PATH） */
  pathDirs?: readonly string[];
}

/**
 * 跑一遍环境自检。
 *
 * **永不抛异常**：任何一步失败都退化成"该项信息缺失"，其余检查照常进行 ——
 * 自检本身失败不该成为用户的新问题。
 *
 * @param input 配置、exe 路径与可注入的依赖，见 {@link PrecheckInput}
 * @returns 自检报告，见 {@link PrecheckReport}
 */
export async function runPrecheck(input: PrecheckInput): Promise<PrecheckReport> {
  const { config, exe } = input;
  const exeDir = exe === "" ? "" : dirname(exe);
  const pathDirs = input.pathDirs ?? (process.env["PATH"] ?? "").split(";").filter((dir) => dir !== "");

  // ---- 文件系统层面的事实 ----
  const exeExists = exe !== "" && existsSync(exe);
  const coreDllMissing = exeExists ? CORE_DLLS.filter((dll) => !resolveDll(dll, [exeDir])) : [];
  const backends = exeDir === "" ? [] : listBackends(exeDir);

  // ---- 从 ggml-cuda.dll 的导入表读出"需要哪个 CUDA" ----
  let pe: PeImports = { imports: [], size: 0, is64: false, error: "未检查" };
  const cudaDll = exeDir === "" ? null : resolveDll("ggml-cuda.dll", [exeDir]);
  if (cudaDll !== null) pe = readPeImports(cudaDll);
  const cuda = parseCudaRuntimeImports(pe.imports);

  // 运行时 DLL 的解析：exe 同目录 → PATH → System32（nvcuda.dll 由驱动装在 System32）
  const systemDir = process.env["SystemRoot"] === undefined ? "" : join(process.env["SystemRoot"], "System32");
  const searchDirs = [exeDir, ...pathDirs, systemDir];
  const missingRuntimeDlls = cuda.runtimeDlls.filter((dll) => resolveDll(dll, searchDirs) === null);
  if (cuda.needsDriver && resolveDll("nvcuda.dll", searchDirs) === null) missingRuntimeDlls.push("nvcuda.dll");

  // ---- 驱动与显卡 ----
  const gpuResult = await (input.queryGpus ?? (() => queryGpus()))();
  const { stdout: smiHeader } = await readNvidiaSmiHeader();
  const driver = parseDriverInfo(smiHeader);
  const primaryGpu = gpuResult.gpus[0] ?? null;

  // ---- 模型 ----
  const modelPath = pickModelPath(config);
  let modelSizeMiB: number | null = null;
  let modelMagicOk: boolean | null = null;
  if (modelPath !== null) {
    try {
      modelSizeMiB = Math.round(statSync(modelPath).size / (1024 * 1024));
    } catch {
      modelSizeMiB = null;
    }
    modelMagicOk = isGgufFile(modelPath);
  }

  // ---- 端口 ----
  let portFree: boolean | null = null;
  const port = typeof config.port === "number" ? config.port : 8080;
  const host = config.host ?? "127.0.0.1";
  try {
    const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    portFree = !(await probeTcp(probeHost, port, 300));
  } catch {
    portFree = null;
  }

  const facts: PrecheckFacts = {
    exe,
    exeExists,
    coreDllMissing,
    backends,
    cudaRuntimeDlls: cuda.runtimeDlls,
    cudaRequiredMajor: cuda.cudaMajor,
    needsDriver: cuda.needsDriver,
    missingRuntimeDlls,
    driverVersion: driver.driverVersion,
    driverMaxCuda: driver.maxCudaVersion,
    gpuName: primaryGpu?.name ?? null,
    vramTotalMiB: primaryGpu?.vramTotalMiB ?? null,
    modelPath,
    modelSizeMiB,
    modelMagicOk,
    portFree,
    presetPathNonAscii:
      typeof config.models_preset === "string" && config.models_preset !== "" && hasNonAsciiPath(config.models_preset),
  };

  const items = buildPrecheckItems(facts);
  const verdict = items.reduce<PrecheckLevel>(
    (worst, item) => (severityOf(item.level) > severityOf(worst) ? item.level : worst),
    "ok",
  );

  return { at: Date.now(), verdict, items, facts };
}

/**
 * 挑出"这次启动真正会加载的那个模型文件"。
 *
 * router 模式优先预加载模型，single 模式用主模型；两者都没配时返回 `null`。
 *
 * @param config 启动配置
 * @returns 模型绝对路径；未指定时为 `null`
 */
export function pickModelPath(config: LauncherConfig): string | null {
  if (config.mode === "router") {
    if (typeof config.preload_model === "string" && config.preload_model !== "" && typeof config.models_dir === "string") {
      return join(config.models_dir, `${config.preload_model}.gguf`);
    }
    return null;
  }
  return typeof config.main_model === "string" && config.main_model !== "" ? config.main_model : null;
}

/**
 * 跑一次 `nvidia-smi`（不带查询参数）并取出头部文本 —— 驱动版本与支持的 CUDA 版本只在头部。
 *
 * @returns `stdout` 为头部输出；命令跑不起来时为空串（调用方按"信息缺失"处理）
 */
async function readNvidiaSmiHeader(): Promise<{ stdout: string }> {
  const result = await runCapture("nvidia-smi", [], 4000);
  return { stdout: `${result.stdout}${result.stderr}` };
}

/**
 * 自检结论里挑出指定级别的项。
 *
 * @param report 自检报告
 * @param level 目标级别
 * @returns 该级别的项
 */
export function itemsOfLevel(report: PrecheckReport, level: PrecheckLevel): PrecheckItem[] {
  return report.items.filter((item) => item.level === level);
}

/**
 * 把自检里的 error/warn 压成一行行告警文本，供启动流程与日志使用。
 *
 * @param report 自检报告
 * @returns 形如 `[环境自检] xxx` 的字符串数组；没有任何问题时为空数组
 */
export function precheckWarnings(report: PrecheckReport): string[] {
  return report.items
    .filter((item) => item.level === "error" || item.level === "warn")
    .map((item) => `[环境自检] ${item.title}${item.suggestion === undefined ? "" : ` —— ${item.suggestion}`}`);
}

/**
 * 取模型文件名（用于展示）。
 *
 * @param path 模型路径
 * @returns 文件名；`null` 输入返回空串
 */
export function modelFileName(path: string | null): string {
  return path === null ? "" : basename(path);
}
