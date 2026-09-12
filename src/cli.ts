#!/usr/bin/env node
/**
 * core 的命令行入口。
 *
 *   node src/cli.ts probe   [--llama-dir PATH] [--help-fixture FILE] [--json]
 *   node src/cli.ts args    [--config PATH] [--help-fixture FILE] [--port N] [--json]
 *   node src/cli.ts run     [--config PATH] [--timeout-ms N] [--open] [--port N]
 *   node src/cli.ts init    [--config PATH] [--force]
 *
 * 为什么 CLI 先做：core 的所有逻辑都能在没有界面的情况下验证，
 * 命令行的输出同时是 GUI 的对拍基准（同一份配置必须产出同一条命令行）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, discoverLlamaDir, discoverModelLayout, loadConfigFile, saveConfigFile } from "./core/config.ts";
import { describeSteps, formatArgv } from "./core/args.ts";
import { prepareLaunch, probeServer, summarizeCapabilities } from "./core/launcher.ts";
import { createCapabilities } from "./core/helpProbe.ts";
import { LlamaServer } from "./core/llamaProcess.ts";
import { baseUrlOf, fetchHealth, findFreePort, probeTcp } from "./core/health.ts";
import { classify } from "./core/logLines.ts";
import type { LauncherConfig } from "./core/types.ts";

/** 解析后的命令行开关：有值的是字符串，纯开关是 `true` */
type Flags = Record<string, string | true>;

/**
 * 解析命令行开关（手写，不引第三方库以维持零依赖）。
 *
 * 支持两种写法：`--key value` 与 `--key=value`；没有跟随值的 `--flag` 记为 `true`。
 *
 * 边界：判断"后面那个是不是值"的依据是它**不以 `--` 开头** ——
 * 因此值本身不能以 `--` 开头（本 CLI 用不到这种情况，如确实需要请用 `--key=--value`）。
 *
 * @param argv 去掉 `node` 与脚本路径、且已剔除子命令名之后的参数
 * @returns `positional` 为位置参数，`flags` 为开关表
 */
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

/**
 * 取字符串形态的开关值。
 *
 * @param flags 开关表
 * @param name 开关名（不含 `--`）
 * @returns 开关的值；不存在、或只是纯开关（`true`）时返回 `null`
 */
function flagString(flags: Flags, name: string): string | null {
  const v = flags[name];
  return typeof v === "string" ? v : null;
}

/** 默认配置文件路径：当前工作目录下的 `llama-launcher.json` */
function defaultConfigPath(): string {
  return join(process.cwd(), "llama-launcher.json");
}

/** {@link loadConfigForCli} 的返回值 */
interface LoadedConfig {
  /** 归一化后的配置 */
  config: LauncherConfig;
  /** 实际读取的路径（可能只是"打算用的默认路径"，见 `existed`） */
  path: string;
  /** 归一化过程中的告警，需要在界面上展示给用户 */
  warnings: string[];
  /** 该文件是否真实存在；`false` 表示用的是默认配置 */
  existed: boolean;
}

/**
 * 读配置：文件不存在时退回默认配置而不是报错。
 *
 * 为什么容忍"文件不存在"：首次使用时配置文件自然还不存在，
 * 此时应该能用默认参数跑起来（并提示用户），而不是甩一个 ENOENT。
 * 若文件不存在还会顺手探测一次 llama.cpp 目录，让默认配置尽量可用。
 *
 * @param flags 命令行开关（只看 `--config`）
 * @returns 配置、路径、告警与"文件是否存在"，见 {@link LoadedConfig}
 * @throws {Error} 文件存在但读不了或 JSON 非法时抛出（由 `loadConfigFile` 抛出）
 */
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

/**
 * 为 `probe` 定出要探测的 exe 路径。
 *
 * 优先级：`--exe` → `--llama-dir` → 配置里的值 → 自动探测当前目录。
 * 每一级都要求文件确实存在，不存在就继续往下找（而不是返回一个不存在的路径）。
 *
 * @param flags 命令行开关
 * @param config 已读到的配置（`probe` 命令可能还没读配置，故可选）
 * @returns exe 的完整路径；四级都落空时返回 `null`
 */
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

/** 日志分类 → ANSI 颜色；未列出的分类不着色（`RESET` 用于关闭着色） */
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
/**
 * `probe`：探测当前 llama.cpp 支持哪些参数，并回答"哪些改了名 / 不支持 / 已废弃"。
 *
 * 两种数据来源：默认现场跑 `--version` + `--help`；给了 `--help-fixture` 则直接读文件
 * （用于离线对拍，不需要真的装一个 llama.cpp）。
 *
 * @param flags 命令行开关：`--llama-dir` / `--exe` / `--help-fixture` / `--json`
 * @returns 退出码：解析到选项为 `0`；找不到 exe 或一个选项都没解析出来为 `1`
 */
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
/**
 * `args`：只打印"最终命令行 + 参数决策表"，**不启动任何进程**。
 *
 * 这是与界面/旧脚本对拍用的命令：同一份配置，这里输出的命令行必须与界面里
 * 显示、以及实际启动时用的一致。`--json` 输出可直接喂给别的脚本做断言。
 *
 * @param flags 命令行开关：`--config` / `--help-fixture` / `--port` / `--json`
 * @returns 退出码：恒为 `0`（拼装失败会抛异常，由顶层统一转成 `1`）
 */
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
/**
 * `run`：真正启动 llama-server，流式打印日志。
 *
 * 行为要点：
 * - 端口被占用时自动顺延，并同步改写命令行里的 `--port`
 * - `SIGINT` / `SIGTERM` 都接了停止逻辑（用 `stopping` 标志防重复），
 *   保证 Ctrl+C 后不会留下占着显存的孤儿进程
 * - 启动失败时打印诊断结论（显存不足 / 端口占用等）并返回退出码 `1`
 * - `--timeout-ms` 用于无人值守的冒烟测试：到点自动停止，不必等人按 Ctrl+C
 * - 不给 `--timeout-ms` 时会一直阻塞等 Ctrl+C（这是给人用的正常模式）
 *
 * @param flags 命令行开关：`--config` / `--port` / `--open` / `--timeout-ms`
 * @returns 退出码：成功 `0`，启动失败 `1`
 */
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
// init
// ---------------------------------------------------------------------------
/**
 * `init`：按当前机器的实际情况生成一份可直接用的配置。
 *
 * 探测规则全部来自 core 的 {@link discoverModelLayout}（与界面「首次运行自动生成配置」共用同一份实现）：
 * llama.cpp 目录 → 同级 `models` 目录 → `presets.ini`（据此定 mode）→ presets 的 `[defaults]`
 * 约定决定是否预加载。这样命令行生成的配置与首次运行生成的配置不会出现两套行为。
 *
 * @param flags 命令行开关：`--config` / `--llama-dir` / `--force`
 * @returns 退出码：写入成功 `0`；文件已存在且没给 `--force` 时 `1`（不覆盖用户配置）
 * @throws {Error} 目标路径不可写时由 `saveConfigFile` 抛出
 */
function cmdInit(flags: Flags): number {
  const path = flagString(flags, "config") ?? defaultConfigPath();
  if (existsSync(path) && flags["force"] !== true) {
    console.error(`配置文件已存在：${path}（加 --force 覆盖）`);
    return 1;
  }
  const layout = discoverModelLayout({
    startDirs: [process.cwd()],
    explicitLlamaDir: flagString(flags, "llama-dir"),
  });

  const config: LauncherConfig = {
    ...DEFAULT_CONFIG,
    llama_dir: layout.llamaDir ?? "",
    mode: layout.mode,
    models_dir: layout.modelsDirExists ? layout.modelsDirCandidate : "",
    models_preset: layout.presetPath,
    preload_model: layout.preloadModel,
  };
  saveConfigFile(path, config);
  console.log(`已写入配置：${path}`);
  console.log(`  llama_dir    ：${config.llama_dir || "（未探测到，请手动填）"}`);
  console.log(`  mode         ：${config.mode}`);
  console.log(`  models_dir   ：${config.models_dir || "（未探测到）"}`);
  console.log(`  models_preset：${config.models_preset || "（未探测到）"}`);
  console.log(`  preload_model：${config.preload_model || "（不预加载，首次请求才加载）"}`);
  return 0;
}

function printHelp(): void {
  console.log(`llama.cpp 启动器 core（零依赖，可用 CLI 驱动）

用法：
  node src/cli.ts probe   [--llama-dir PATH] [--help-fixture FILE] [--json]
  node src/cli.ts args    [--config PATH] [--help-fixture FILE] [--port N] [--json]
  node src/cli.ts run     [--config PATH] [--timeout-ms N] [--open] [--port N]
  node src/cli.ts init    [--config PATH] [--force]

说明：
  probe   跑 llama-server --version/--help，列出参数改名、不支持、已废弃的情况
  args    只打印最终命令行与"参数决策表"，不启动任何进程（对拍用）
  run     真正启动 llama-server，流式打印日志、自动健康检查、失败给诊断
  --help-fixture FILE  用离线 help 文本代替现场探测（离线测试/对拍用）
`);
}

// ---------------------------------------------------------------------------
// 入口：派发子命令并统一处理退出码
//   - 子命令自己返回退出码（0 成功 / 1 失败），便于脚本串联
//   - 抛出的异常在这里统一转成"人话 + 退出码 1"，不打印堆栈（对使用者没用）
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
