/**
 * 启动编排层：把「配置 → 探测 → presets → 命令行」串起来。
 *
 * CLI 和 Electron 主进程都只调这一层，保证 GUI 与命令行行为完全一致 ——
 * 这样才谈得上"同一份配置产出同一条命令行"。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildArgs } from "./args.ts";
import type { BuildStep } from "./types.ts";
import { discoverLlamaDir, resolveModelFile, resolveServerExe } from "./config.ts";
import type { LauncherConfig } from "./types.ts";
import { createCapabilities, readBuildNumber } from "./helpProbe.ts";
import type { Capabilities, ParamSpec } from "./types.ts";
import { PARAM_SPECS } from "./schema.ts";
import {
  collectPresetKeys,
  getNumericPresetValue,
  presetFileFromJson,
  renderPresetFile,
  stagePresetText,
} from "./presets.ts";
import type { PresetFile } from "./presets.ts";
import { runCapture } from "./llamaProcess.ts";

/** {@link probeServer} 的返回值：版本号 + 原始输出，供能力视图与界面展示使用 */
export interface ServerProbe {
  /** 从 `--version` 里解析出的 build 号；解析不出为 `null` */
  build: number | null;
  /** `--version` 的完整输出（stdout + stderr），展示用 */
  versionText: string;
  /** `--help` 的完整输出（stdout + stderr），是能力视图的唯一来源 */
  helpText: string;
  /** 探测过程中的失败原因（命令跑不起来 / 超时 / 拿不到 help）；正常时为 `undefined` */
  error?: string;
}

/**
 * 跑 `--version` 与 `--help`，拿到版本号和"这个版本到底支持什么"的原始依据。
 *
 * 两个命令的输出都按 **stdout + stderr 拼接**：llama.cpp 的版本横幅历史上走过 stderr，
 * 只读 stdout 会拿到空字符串。
 *
 * 本函数**不抛异常**：命令跑不起来时把原因放进 `error` 字段，
 * 由调用方决定是告警继续（用空的 help 文本降级）还是中止。
 *
 * @param exe `llama-server.exe` 的完整路径
 * @returns 探测结果，见 {@link ServerProbe}
 */
export async function probeServer(exe: string): Promise<ServerProbe> {
  const version = await runCapture(exe, ["--version"]);
  const help = await runCapture(exe, ["--help"]);
  const versionText = `${version.stdout}${version.stderr}`;
  const helpText = `${help.stdout}${help.stderr}`;
  return {
    build: readBuildNumber(versionText),
    versionText,
    helpText,
    error: version.error ?? help.error ?? (helpText.trim() === "" ? "拿不到 --help 输出" : undefined),
  };
}

/**
 * 用参数表逐条对照当前版本，回答"哪些参数改了名 / 不支持 / 已废弃"。
 *
 * 三类结果的判定方式：
 * - `unsupported`：候选名一个都没命中 → 该参数无法用于这个版本（界面置灰）
 * - `renamed`：命中的不是候选里的首选名 → 说明版本改过名，
 *   例如候选 `["--draft-type-k", "--spec-draft-type-k"]` 在 b10488 上命中后者
 * - `deprecated`：命中的选项在 help 里被标了 `DEPRECATED`（如 `--mlock`）
 *
 * 无候选名的参数（如走自定义参数栏的项）直接跳过，不计入任何一类。
 */
export interface CapabilitySummary {
  optionCount: number;
  sections: string[];
  /** schema 里定义、但当前版本一个候选都没命中的参数（GUI 里灰掉） */
  unsupported: { key: string; label: string; candidates: string[] }[];
  /** 命中了候选但不是首选名 —— 说明版本改过名 */
  renamed: { key: string; label: string; used: string; preferred: string }[];
  /** 命中的参数在 help 里标了 DEPRECATED */
  deprecated: { key: string; label: string; flag: string }[];
}

function specList(): readonly ParamSpec[] {
  return PARAM_SPECS;
}

/**
 * 遍历参数表，把"当前版本对每个参数的支持情况"归类汇总。
 *
 * 这是 `probe` 子命令与界面「环境自检」的数据来源：
 * 它只回答事实（谁不支持、谁改了名），不替用户做决定。
 *
 * @param caps 当前版本的能力视图（通常来自 {@link probeServer} 的 helpText）
 * @returns 汇总结果，见 {@link CapabilitySummary}；三个数组都可能是空的
 */
export function summarizeCapabilities(caps: Capabilities): CapabilitySummary {
  const unsupported: CapabilitySummary["unsupported"] = [];
  const renamed: CapabilitySummary["renamed"] = [];
  const deprecated: CapabilitySummary["deprecated"] = [];

  for (const spec of specList()) {
    if (spec.candidates.length === 0) continue;
    const used = caps.pick(spec.candidates);
    if (used === null) {
      unsupported.push({ key: spec.key, label: spec.label, candidates: [...spec.candidates] });
      continue;
    }
    const preferred = spec.candidates[0];
    if (used !== preferred) {
      renamed.push({ key: spec.key, label: spec.label, used, preferred });
    }
    if (caps.option(used)?.deprecated === true) {
      deprecated.push({ key: spec.key, label: spec.label, flag: used });
    }
  }

  return {
    optionCount: caps.model.options.length,
    sections: [...caps.model.sections],
    unsupported,
    renamed,
    deprecated,
  };
}

/** {@link prepareLaunch} 的可选开关 */
export interface PrepareOptions {
  /** 已探测好的 help 文本（离线测试用；不给就现场跑 --help） */
  helpText?: string;
  /** 跳过探测（必须同时给 helpText，否则报错） */
  skipProbe?: boolean;
  /** 非 ASCII 的 presets 路径往哪个目录拷（默认 process.env.TEMP） */
  asciiTempDir?: string;
  /** 纯 CPU 场景：拼命令行时不再回退 `-ngl 99` */
  cpuOnly?: boolean;
}

/** {@link prepareLaunch} 的结果：一次启动所需的全部信息，**不含**进程本身 */
export interface PrepareResult {
  /** 实际要执行的 `llama-server.exe` 路径 */
  exe: string;
  /** 监听地址；`0.0.0.0` 表示所有网卡 */
  host: string;
  /** 最终使用的端口 */
  port: number;
  /** 拼装好的命令行参数（不含 exe 自身） */
  argv: string[];
  /** 需要附加给子进程的环境变量（如思考开关的 kwargs） */
  env: Record<string, string>;
  /** 参数决策表：每个参数为什么传 / 为什么不传 */
  steps: BuildStep[];
  /** 面向用户的告警（配置问题、版本差异、自动降级等） */
  warnings: string[];
  /** 预加载模型的绝对路径；`null` = 不预加载 */
  preloadModelFile: string | null;
  /** 解析后的 presets.ini；没配或文件不存在时为 `null` */
  presetFile: PresetFile | null;
  /** 真正传给 `--models-preset` 的路径（可能是临时目录里的裁剪版） */
  presetArgPath: string | null;
  /** 现场探测的原始结果；用 `helpText` 跳过探测时为 `null` */
  probe: ServerProbe | null;
  /** 能力视图，`buildArgs` 的输入之一 */
  caps: Capabilities;
  /** 支持情况汇总，供 `probe` 命令与界面展示 */
  capabilities: CapabilitySummary;
}

/**
 * 准备一次启动所需的全部信息（**不启动进程**）。
 *
 * 把「找 exe → 探测能力 → 读 presets → 解析预加载模型 → 拼命令行」串成一条流水线，
 * 于是"打印命令""导出配置""真正启动"可以共用同一份结果，不会长出两套逻辑。
 * 这也是"界面里看到的命令 === 实际启动的命令"这条保证的落点。
 *
 * 关键分支：
 * 1. **找 exe**：配置里给的路径优先；配了但文件不在则告警并转为自动探测；
 *    都失败才抛错（此时继续没有任何意义）
 * 2. **探测能力**：给了 `helpText` 就用现成的（离线对拍用），否则现场跑 `--help`；
 *    探测失败只告警不中止，后续按"空 help"降级（结果是大部分参数走"版本不支持"分支）
 * 3. **presets**：读配置用**原始文件**（`[defaults]` 是启动器自己的约定），
 *    但传给 llama-server 的那一份会剔除启动器自用段；路径含非 ASCII 或做过裁剪时，
 *    统一改写为临时目录里的副本，并把原因写进 `warnings`
 * 4. **预加载模型**：`<models_dir>/<preload_model>.gguf` 存在才算数，
 *    并从 presets 里读出该模型的 `ctx-size` —— 因为实测预加载的模型不吃 preset，
 *    ctx 必须由命令行直传
 *
 * @param config 归一化后的配置（`llama_dir` 为空时会走自动探测）
 * @param options 可选项，见 {@link PrepareOptions}
 * @returns 启动所需信息，见 {@link PrepareResult}
 * @throws {Error} 找不到可用的 `llama-server.exe`；或 `skipProbe` 为真却没给 `helpText`
 */
export async function prepareLaunch(config: LauncherConfig, options: PrepareOptions = {}): Promise<PrepareResult> {
  const warnings: string[] = [];

  // ---- 1. 找 exe ----
  let exe = resolveServerExe(config);
  if (exe !== "" && !existsSync(exe)) {
    warnings.push(`配置里的 llama-server 不存在：${exe}`);
    exe = "";
  }
  if (exe === "") {
    const discovered = discoverLlamaDir([process.cwd(), config.llama_dir].filter(Boolean));
    if (discovered !== null) {
      exe = join(discovered, "llama-server.exe");
      warnings.push(`配置里没给可用的 llama.cpp 目录，已自动探测到：${discovered}`);
    }
  }
  if (exe === "") {
    throw new Error(
      "找不到 llama-server.exe：请在配置里设置 llama_dir（或 server_exe），或设置环境变量 LLAMA_DIR / LLAMA_SERVER",
    );
  }

  // ---- 2. 探测当前版本支持哪些参数 ----
  let probe: ServerProbe | null = null;
  let helpText = options.helpText ?? "";
  if (helpText === "") {
    if (options.skipProbe === true) {
      throw new Error("skipProbe 模式下必须通过 helpText 提供 --help 文本");
    }
    probe = await probeServer(exe);
    helpText = probe.helpText;
    if (probe.error !== undefined) warnings.push(`探测 llama.cpp 能力失败：${probe.error}`);
  }
  const caps = createCapabilities(helpText);
  const capabilities = summarizeCapabilities(caps);

  // ---- 3. 模型预设：JSON → 渲染成 llama-server 认的 ini → 临时文件 ----
  // 预设现在存在配置里（config.presets），ini 只是递给服务器的中间产物：
  // 路径由我们生成在 %TEMP%（不可能含非 ASCII），也不会写出 [defaults] 那种假模型段。
  let presetFile: PresetFile | null = null;
  let presetArgPath: string | null = null;
  const presetJson = config.presets ?? {};
  const presetNames = Object.keys(presetJson);
  if (config.mode === "router" && presetNames.length > 0) {
    presetFile = presetFileFromJson(presetJson, config.preload_model ?? null);
    const text = renderPresetFile(presetFile);
    if (text !== "") {
      const tempDir = options.asciiTempDir ?? process.env["TEMP"] ?? process.cwd();
      presetArgPath = stagePresetText(text, tempDir);
    }
  } else if (config.mode === "router" && config.models_preset) {
    // 老配置：字段还在，但不再直接传给 llama-server。给一条明确的迁移提示，
    // 免得用户以为"配了却没生效"。
    warnings.push(
      `配置里的 models_preset（${config.models_preset}）已不再直接传给 llama-server；` +
        "请在界面上点「导入 presets.ini…」把内容并进配置的 presets 字段（导入后这个路径只作参考）",
    );
  }

  // ---- 4. 预加载模型 ----
  let preloadModelFile: string | null = null;
  let preloadCtxFromPreset: number | null = null;
  if (config.mode === "router" && config.preload_model && config.models_dir) {
    const candidate = join(config.models_dir, `${config.preload_model}.gguf`);
    if (existsSync(candidate)) {
      preloadModelFile = candidate;
      if (presetFile !== null) {
        preloadCtxFromPreset = getNumericPresetValue(presetFile, config.preload_model, "ctx-size");
      }
    } else {
      warnings.push(`预加载模型不存在：${candidate}（模型 ID = GGUF 文件名去掉 .gguf），已改为按需加载`);
    }
  }

  // ---- 5. single 模式：主模型留空时按 preload_model 兜底 ----
  // 配置里已经写了模型名（preload_model）时不该再逼用户填一遍完整路径。
  let mainModelFile: string | null = null;
  if (config.mode !== "router" && (config.main_model ?? "") === "") {
    const derived = resolveModelFile(config);
    if (derived !== null) {
      if (existsSync(derived)) {
        mainModelFile = derived;
        warnings.push(`single 模式没指定主模型，已按配置里的 preload_model 使用：${derived}`);
      } else {
        warnings.push(`single 模式没指定主模型，按 preload_model 推出的文件不存在：${derived}`);
      }
    }
  }

  // ---- 6. 拼命令行 ----
  const build = buildArgs({
    config,
    caps,
    presetKeys: presetFile !== null ? collectPresetKeys(presetFile) : [],
    preloadModelFile,
    preloadCtxFromPreset,
    presetArgPath,
    mainModelFile,
    cpuOnly: options.cpuOnly ?? false,
  });

  const host = config.host ?? "127.0.0.1";
  const port = typeof config.port === "number" ? config.port : 8080;

  return {
    exe,
    host,
    port,
    argv: build.argv,
    env: build.env,
    steps: build.steps,
    warnings: [...warnings, ...build.warnings],
    preloadModelFile,
    presetFile,
    presetArgPath,
    probe,
    caps,
    capabilities,
  };
}

async function readTextFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
