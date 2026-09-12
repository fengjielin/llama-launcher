#!/usr/bin/env node
/**
 * core 的命令行入口。
 *
 *   node src/cli.ts probe   [--llama-dir PATH] [--help-fixture FILE] [--json]
 *   node src/cli.ts args    [--config PATH] [--help-fixture FILE] [--port N] [--json]
 *   node src/cli.ts run     [--config PATH] [--timeout-ms N] [--open] [--port N]
 *   node src/cli.ts init    [--config PATH] [--force]
 *   node src/cli.ts migrate --from <v1.9配置.json> [--to PATH]
 *
 * 为什么 CLI 先做：core 的所有逻辑都能在没有界面的情况下验证，
 * 命令行的输出同时是 GUI 的对拍基准（同一份配置必须产出同一条命令行）。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG, discoverLlamaDir, loadConfigFile, normalizeConfig, saveConfigFile } from "./core/config.ts";
import { describeSteps, formatArgv } from "./core/args.ts";
import { prepareLaunch, probeServer, summarizeCapabilities } from "./core/launcher.ts";
import { createCapabilities } from "./core/helpProbe.ts";
import { parsePresetsIni } from "./core/presets.ts";
import { LlamaServer } from "./core/llamaProcess.ts";
import { baseUrlOf, fetchHealth, findFreePort, probeTcp } from "./core/health.ts";
import { classify } from "./core/logLines.ts";
import type { LauncherConfig } from "./core/types.ts";

type Flags = Record<string, string | true>;

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

function flagString(flags: Flags, name: string): string | null {
  const v = flags[name];
  return typeof v === "string" ? v : null;
}

function defaultConfigPath(): string {
  return join(process.cwd(), "llama-launcher.json");
}

interface LoadedConfig {
  config: LauncherConfig;
  path: string;
  warnings: string[];
  existed: boolean;
}

function loadConfigForCli(flags: Flags): LoadedConfig {
  const path = flagString(flags, "config") ?? defaultConfigPath();
  const warnings: string[] = [];
  if (!existsSync(path)) {
    const discovered = discoverLlamaDir([process.cwd()]);
    const config = { ...DEFAULT_CONFIG, llama_dir: discovered ?? "" };
    warnings.push(`配置文件不存在（${path}），已使用默认值${discovered ? ` + 自动探测到 ${discovered}` : ""}`);
    return { config, path, warnings, existed: false };
  }
  const result = loadConfigFile(path);
  return { config: result.config, path, warnings: [...warnings, ...result.warnings], existed: true };
}

/** 探测用：优先 --llama-dir / --exe，其次配置，最后自动探测 */
function resolveExeForProbe(flags: Flags, config?: LauncherConfig): string | null {
  const exeFlag = flagString(flags, "exe");
  if (exeFlag !== null && existsSync(exeFlag)) return exeFlag;
  const dirFlag = flagString(flags, "llama-dir");
  if (dirFlag !== null) {
    const candidate = join(dirFlag, "llama-server.exe");
    if (existsSync(candidate)) return candidate;
  }
  if (config !== undefined) {
    const fromConfig = config.server_exe && existsSync(config.server_exe)
      ? config.server_exe
      : config.llama_dir !== ""
        ? join(config.llama_dir, "llama-server.exe")
        : "";
    if (fromConfig !== "" && existsSync(fromConfig)) return fromConfig;
  }
  const discovered = discoverLlamaDir([process.cwd()]);
  return discovered === null ? null : join(discovered, "llama-server.exe");
}

const COLOR: Record<string, string> = {
  error: "\x1b[31m",
  oom: "\x1b[41;97m",
  warning: "\x1b[33m",
  listening: "\x1b[32m",
  "model-loaded": "\x1b[36m",
  "model-list": "\x1b[36m",
  perf: "\x1b[35m",
};
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------
async function cmdProbe(flags: Flags): Promise<number> {
  const exe = resolveExeForProbe(flags);
  if (exe === null) {
    console.error("找不到 llama-server.exe：用 --llama-dir 指定，或设置 LLAMA_DIR / LLAMA_SERVER");
    return 1;
  }
  const fixture = flagString(flags, "help-fixture");
  let helpText = "";
  let versionText = "";
  let build: number | null = null;

  if (fixture !== null) {
    helpText = readFileSync(fixture, "utf8");
  } else {
    const probe = await probeServer(exe);
    helpText = probe.helpText;
    versionText = probe.versionText;
    build = probe.build;
    if (probe.error !== undefined) console.error(`⚠ ${probe.error}`);
  }

  const caps = createCapabilities(helpText);
  const summary = summarizeCapabilities(caps);

  if (flags["json"] === true) {
    console.log(JSON.stringify({ exe, build, version: versionText.trim(), ...summary }, null, 2));
    return summary.optionCount === 0 ? 1 : 0;
  }

  console.log(`可执行文件 : ${exe}`);
  if (build !== null) console.log(`构建版本   : b${build}`);
  if (versionText.trim() !== "") console.log(`版本信息   : ${versionText.trim().split("\n")[0]}`);
  console.log(`解析到选项 : ${summary.optionCount} 个`);
  console.log(`分节       : ${summary.sections.join(" / ")}`);

  console.log(`\n参数名已改名（本版本实际用哪个）: ${summary.renamed.length} 项`);
  for (const r of summary.renamed) {
    console.log(`  · ${r.label.padEnd(12)} 首选 ${r.preferred} → 实际 ${r.used}`);
  }

  console.log(`\n本版本不支持（GUI 应置灰）: ${summary.unsupported.length} 项`);
  for (const u of summary.unsupported) {
    console.log(`  · ${u.label.padEnd(12)} 候选 ${u.candidates.join(" / ")}`);
  }

  console.log(`\n已废弃但仍命中的参数: ${summary.deprecated.length} 项`);
  for (const d of summary.deprecated) {
    console.log(`  · ${d.label.padEnd(12)} ${d.flag}`);
  }
  return summary.optionCount === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
async function cmdArgs(flags: Flags): Promise<number> {
  const loaded = loadConfigForCli(flags);
  const portFlag = flagString(flags, "port");
  if (portFlag !== null) loaded.config.port = Number(portFlag);

  const fixture = flagString(flags, "help-fixture");
  const prepared = await prepareLaunch(loaded.config, fixture !== null ? { helpText: readFileSync(fixture, "utf8") } : {});

  if (flags["json"] === true) {
    console.log(
      JSON.stringify(
        {
          config: loaded.path,
          exe: prepared.exe,
          argv: prepared.argv,
          command: `${prepared.exe} ${formatArgv(prepared.argv)}`,
          env: prepared.env,
          steps: prepared.steps,
          warnings: prepared.warnings,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`配置文件   : ${loaded.path}${loaded.existed ? "" : "（不存在，用默认值）"}`);
  console.log(`可执行文件 : ${prepared.exe}`);
  console.log(`监听       : ${baseUrlOf(prepared.host, prepared.port)}`);

  console.log("\n启动命令：");
  console.log(`  ${prepared.exe} ${formatArgv(prepared.argv)}`);

  if (Object.keys(prepared.env).length > 0) {
    console.log("\n附加环境变量：");
    for (const [k, v] of Object.entries(prepared.env)) console.log(`  ${k}=${v}`);
  }

  const warnings = [...loaded.warnings, ...prepared.warnings];
  if (warnings.length > 0) {
    console.log("\n提醒：");
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }

  console.log("\n参数决策表（每个参数为什么传 / 为什么不传）：");
  console.log(describeSteps(prepared.steps));
  return 0;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
async function cmdRun(flags: Flags): Promise<number> {
  const loaded = loadConfigForCli(flags);
  const prepared = await prepareLaunch(loaded.config);

  const portFlag = flagString(flags, "port");
  let port = portFlag !== null ? Number(portFlag) : prepared.port;

  // 端口被占用就顺延（与 PS1 的"被占用会自动顺延"一致）
  const probeHost = prepared.host === "0.0.0.0" || prepared.host === "::" ? "127.0.0.1" : prepared.host;
  if (await probeTcp(probeHost, port, 300)) {
    const next = await findFreePort(probeHost, port + 1);
    console.log(`端口 ${port} 已被占用，自动改用 ${next}`);
    port = next;
    const rebuilt = prepared.argv.slice();
    const idx = rebuilt.indexOf("--port");
    if (idx !== -1) rebuilt[idx + 1] = String(port);
    prepared.argv = rebuilt;
  }

  console.log(`可执行文件 : ${prepared.exe}`);
  console.log(`启动命令   : ${prepared.exe} ${formatArgv(prepared.argv)}`);
  for (const w of [...loaded.warnings, ...prepared.warnings]) console.log(`  ⚠ ${w}`);
  console.log("");

  const server = new LlamaServer();
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    console.log("\n正在停止 llama-server…");
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const report = await server.start({
    exe: prepared.exe,
    argv: prepared.argv,
    host: prepared.host,
    port,
    env: prepared.env,
    onState: (state, note) => console.log(`[状态] ${state} - ${note}`),
    onLine: (line, event) => {
      const color = COLOR[event.kind] ?? "";
      console.log(`${color}${line}${color === "" ? "" : RESET}`);
    },
  });

  if (!report.ready) {
    console.error(`\n启动失败：${report.note}`);
    if (report.diagnosis !== null) {
      console.error(`\n诊断：${report.diagnosis.summary}`);
      for (const s of report.diagnosis.suggestions) console.error(`  · ${s}`);
    }
    await server.stop();
    return 1;
  }

  const url = baseUrlOf(prepared.host, port);
  console.log(`\n服务已就绪：${url}`);

  const health = await fetchHealth(url);
  if (health.state === "loading") {
    console.log("提示：router 模式下 /health 返回 503 表示服务在、模型还没加载（不是故障）");
  }

  if (flags["open"] === true) {
    const { spawn } = await import("node:child_process");
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    console.log("已尝试打开浏览器");
  }

  const timeoutFlag = flagString(flags, "timeout-ms");
  if (timeoutFlag !== null) {
    const ms = Number(timeoutFlag);
    console.log(`\n${ms} ms 后自动停止（--timeout-ms）`);
    await new Promise((r) => setTimeout(r, ms));
    await server.stop();
    console.log("已停止");
    return 0;
  }

  console.log("\n按 Ctrl+C 停止（保持这个窗口开着，关掉即停止服务）");
  await new Promise<void>(() => {
    /* 等 Ctrl+C */
  });
  return 0;
}

// ---------------------------------------------------------------------------
// init / migrate
// ---------------------------------------------------------------------------
function cmdInit(flags: Flags): number {
  const path = flagString(flags, "config") ?? defaultConfigPath();
  if (existsSync(path) && flags["force"] !== true) {
    console.error(`配置文件已存在：${path}（加 --force 覆盖）`);
    return 1;
  }
  const llamaDir = flagString(flags, "llama-dir") ?? discoverLlamaDir([process.cwd()]) ?? "";
  const parent = llamaDir !== "" ? dirname(llamaDir) : process.cwd();

  const modelsDir = join(parent, "models");
  const presetCandidates = [join(parent, "presets.ini"), join(parent, "一键启动脚本", "presets.ini")];
  const preset = presetCandidates.find((p) => existsSync(p)) ?? "";

  // presets.ini 的 [defaults] 段可以约定 `; default-model = xxx` 来指定启动预加载的模型。
  // 实测（以及 PS1 的读取逻辑）注释形式也生效，所以生成的配置要跟当前行为保持一致。
  let preload = "";
  if (preset !== "") {
    const parsed = parsePresetsIni(readFileSync(preset, "utf8"));
    if (parsed.defaultModel !== null && existsSync(join(modelsDir, `${parsed.defaultModel}.gguf`))) {
      preload = parsed.defaultModel;
    }
  }

  const config: LauncherConfig = {
    ...DEFAULT_CONFIG,
    llama_dir: llamaDir,
    mode: preset !== "" ? "router" : "single",
    models_dir: existsSync(modelsDir) ? modelsDir : "",
    models_preset: preset,
    preload_model: preload,
  };
  saveConfigFile(path, config);
  console.log(`已写入配置：${path}`);
  console.log(`  llama_dir    ：${config.llama_dir || "（未探测到，请手动填）"}`);
  console.log(`  mode         ：${config.mode}`);
  console.log(`  models_dir   ：${config.models_dir || "（未探测到）"}`);
  console.log(`  models_preset：${config.models_preset || "（未探测到）"}`);
  console.log(`  preload_model：${preload || "（不预加载，首次请求才加载）"}`);
  return 0;
}

function cmdMigrate(flags: Flags): number {
  const from = flagString(flags, "from");
  if (from === null) {
    console.error("需要 --from <v1.9 的 llama_launcher_config.json>");
    return 1;
  }
  const raw: unknown = JSON.parse(readFileSync(from, "utf8"));
  const { config, warnings } = normalizeConfig(raw);
  const to = flagString(flags, "to") ?? join(dirname(resolve(from)), "llama-launcher.json");
  saveConfigFile(to, config);
  console.log(`已迁移：${from} → ${to}`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  console.log("\n迁移后关键项：");
  console.log(`  mode        : ${config.mode}`);
  console.log(`  context     : ${config.context}`);
  console.log(`  max_predict : ${config.max_predict}`);
  console.log(`  think       : ${config.think}`);
  console.log(`  kv          : ${config.kv_k_type} / ${config.kv_v_type}`);
  return 0;
}

function printHelp(): void {
  console.log(`llama.cpp 启动器 core（零依赖，可用 CLI 驱动）

用法：
  node src/cli.ts probe   [--llama-dir PATH] [--help-fixture FILE] [--json]
  node src/cli.ts args    [--config PATH] [--help-fixture FILE] [--port N] [--json]
  node src/cli.ts run     [--config PATH] [--timeout-ms N] [--open] [--port N]
  node src/cli.ts init    [--config PATH] [--force]
  node src/cli.ts migrate --from <v1.9配置.json> [--to PATH]

说明：
  probe   跑 llama-server --version/--help，列出参数改名、不支持、已废弃的情况
  args    只打印最终命令行与"参数决策表"，不启动任何进程（对拍用）
  run     真正启动 llama-server，流式打印日志、自动健康检查、失败给诊断
  --help-fixture FILE  用离线 help 文本代替现场探测（离线测试/对拍用）
`);
}

// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const { flags } = parseFlags(argv.slice(1));

let exitCode = 0;
try {
  if (command === "probe") exitCode = await cmdProbe(flags);
  else if (command === "args") exitCode = await cmdArgs(flags);
  else if (command === "run") exitCode = await cmdRun(flags);
  else if (command === "init") exitCode = cmdInit(flags);
  else if (command === "migrate") exitCode = cmdMigrate(flags);
  else if (command === "help" || flags["help"] === true) printHelp();
  else {
    console.error(`未知命令：${command}`);
    printHelp();
    exitCode = 1;
  }
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
}
process.exit(exitCode);
