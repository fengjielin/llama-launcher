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
import { discoverLlamaDir, resolveServerExe } from "./config.ts";
import type { LauncherConfig } from "./types.ts";
import { createCapabilities, readBuildNumber } from "./helpProbe.ts";
import type { Capabilities, ParamSpec } from "./types.ts";
import { PARAM_SPECS } from "./schema.ts";
import {
  collectPresetKeys,
  getNumericPresetValue,
  hasNonAsciiPath,
  parsePresetsIni,
  renderPresetForServer,
  stagePresetText,
} from "./presets.ts";
import type { PresetFile } from "./presets.ts";
import { runCapture } from "./llamaProcess.ts";

export interface ServerProbe {
  build: number | null;
  versionText: string;
  helpText: string;
  error?: string;
}

/** 跑 `--version` + `--help`，拿到版本号与能力视图 */
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

export interface PrepareOptions {
  /** 已探测好的 help 文本（离线测试用；不给就现场跑 --help） */
  helpText?: string;
  /** 跳过探测（必须同时给 helpText，否则报错） */
  skipProbe?: boolean;
  /** 非 ASCII 的 presets 路径往哪个目录拷（默认 process.env.TEMP） */
  asciiTempDir?: string;
  cpuOnly?: boolean;
}

export interface PrepareResult {
  exe: string;
  host: string;
  port: number;
  argv: string[];
  env: Record<string, string>;
  steps: BuildStep[];
  warnings: string[];
  preloadModelFile: string | null;
  presetFile: PresetFile | null;
  presetArgPath: string | null;
  probe: ServerProbe | null;
  caps: Capabilities;
  capabilities: CapabilitySummary;
}

/**
 * 准备一次启动所需的全部信息（不启动进程）。
 * 这样「打印命令」「导出配置」「真正启动」可以共用同一份结果，不会出现两套逻辑。
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

  // ---- 3. presets.ini ----
  let presetFile: PresetFile | null = null;
  let presetArgPath: string | null = null;
  if (config.mode === "router" && config.models_preset && existsSync(config.models_preset)) {
    const presetPath = resolve(config.models_preset);
    const rawText = await readTextFile(presetPath);
    // 读配置用原始文件（[defaults] 段是启动器自己的约定）
    presetFile = parsePresetsIni(rawText);

    // 传给 llama-server 的那份要剔掉启动器自用段，否则 [defaults] 会变成一个假模型
    const { text: serverText, removedSections } = renderPresetForServer(rawText);
    const tempDir = options.asciiTempDir ?? process.env["TEMP"] ?? process.cwd();

    if (hasNonAsciiPath(presetPath)) {
      presetArgPath = stagePresetText(serverText, tempDir);
      warnings.push("presets.ini 路径含非 ASCII 字符，已拷到临时目录再传给 llama-server（否则会直接崩退）");
    } else if (removedSections.length > 0) {
      presetArgPath = stagePresetText(serverText, tempDir);
      warnings.push(
        `presets.ini 的 [${removedSections.join("], [")}] 段是启动器自己的约定；实测 llama-server 会把它当成一个同名模型` +
          `（启动日志里 Available models 会多出一行 * defaults），已剔除后再传给 llama-server`,
      );
    } else {
      presetArgPath = presetPath;
    }

    if (presetFile.defaultModel !== null && !config.preload_model) {
      warnings.push(`presets.ini 的 [defaults] 里写着 default-model = ${presetFile.defaultModel}，但配置里没启用预加载`);
    }
  } else if (config.mode === "router" && config.models_preset) {
    warnings.push(`presets.ini 不存在：${config.models_preset}`);
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

  // ---- 5. 拼命令行 ----
  const build = buildArgs({
    config,
    caps,
    presetKeys: presetFile !== null ? collectPresetKeys(presetFile) : [],
    preloadModelFile,
    preloadCtxFromPreset,
    presetArgPath,
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
