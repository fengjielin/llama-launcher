/**
 * 把 core 的结果转成 IPC 载荷。
 *
 * 刻意做成纯函数、且**不 import electron** —— 这样界面用的数据形态可以被单测覆盖，
 * 而不是"只能靠眼睛看界面"。
 */

import { createCapabilities } from "../core/helpProbe.ts";
import { summarizeCapabilities } from "../core/launcher.ts";
import type { PrepareResult, ServerProbe } from "../core/launcher.ts";
import { formatArgv } from "../core/args.ts";
import { baseUrlOf } from "../core/health.ts";
import { PARAM_GROUPS, PARAM_SPECS } from "../core/schema.ts";
import type { Capabilities, LauncherConfig } from "../core/types.ts";
import type { LogEvent } from "../core/logLines.ts";
import type { PresetFile } from "../core/presets.ts";
import type {
  DetectPayload,
  LogPush,
  PresetPayload,
  PreviewPayload,
  SchemaEntry,
  SchemaPayload,
  StartReportPayload,
} from "../shared/ipc.ts";

/**
 * 参数表 + 当前版本的支持情况。
 *
 * `caps` 为 null 表示还没探测过 —— 此时 supported 是 null（界面显示"未探测"），
 * 而不是乐观地当成支持：宁可让用户先点一次探测，也别拼出一条跑不起来的命令。
 *
 * @param caps 能力视图；传 `null` 表示"尚未探测"
 * @returns 分组信息 + 每个参数的完整描述（含是否支持、实际参数名、取值形式、是否已废弃）
 */
export function buildSchemaPayload(caps: Capabilities | null): SchemaPayload {
  const entries: SchemaEntry[] = PARAM_SPECS.map((spec) => {
    if (spec.candidates.length === 0) {
      return {
        key: spec.key,
        label: spec.label,
        group: spec.group,
        kind: spec.kind,
        candidates: [],
        presetKey: spec.presetKey,
        enumValues: spec.enumValues ? [...spec.enumValues] : undefined,
        hint: spec.hint,
        supported: true,
        resolvedFlag: null,
        takesValue: true,
        deprecated: false,
      };
    }

    const resolvedFlag = caps === null ? null : caps.pick(spec.candidates);
    const option = caps === null || resolvedFlag === null ? undefined : caps.option(resolvedFlag);
    return {
      key: spec.key,
      label: spec.label,
      group: spec.group,
      kind: spec.kind,
      candidates: [...spec.candidates],
      presetKey: spec.presetKey,
      enumValues: spec.enumValues ? [...spec.enumValues] : undefined,
      hint: spec.hint,
      supported: caps === null ? null : resolvedFlag !== null,
      resolvedFlag,
      takesValue: caps === null ? true : resolvedFlag === null ? false : caps.hasValue(resolvedFlag),
      deprecated: option?.deprecated === true,
    };
  });

  return {
    groups: PARAM_GROUPS.map((g) => ({ id: g.id, label: g.label })),
    entries,
  };
}

/**
 * 把一次能力探测的结果打包成界面用的载荷。
 *
 * 探测"成功但没解析出任何选项"也算失败（`ok: false`）—— 空参数表会让界面把
 * 所有参数都标成"本版本不支持"，不如直接告诉用户探测没成功。
 *
 * @param exe 被探测的 `llama-server.exe` 路径（展示用）
 * @param probe `probeServer` 的原始结果
 * @returns 成功时含版本行、选项数、分节与三类差异清单，并带一份"已解析"的参数表；
 *   失败时 `ok: false` + `failure` 说明原因，且参数表退化为"未探测"状态
 */
export function buildDetectPayload(exe: string, probe: ServerProbe): DetectPayload {
  const helpText = probe.helpText.trim();
  const caps = helpText === "" ? null : createCapabilities(helpText);
  const summary = caps === null ? null : summarizeCapabilities(caps);
  const versionLine = firstLine(probe.versionText);

  if (caps === null || summary === null || summary.optionCount === 0) {
    return {
      ok: false,
      failure: probe.error ?? "拿不到可用的 --help 输出，无法判断当前版本支持哪些参数",
      exe,
      build: probe.build,
      versionLine,
      optionCount: 0,
      sections: [],
      unsupported: [],
      renamed: [],
      deprecated: [],
      schema: buildSchemaPayload(null),
    };
  }

  return {
    ok: true,
    exe,
    build: probe.build,
    versionLine,
    optionCount: summary.optionCount,
    sections: summary.sections,
    unsupported: summary.unsupported,
    renamed: summary.renamed,
    deprecated: summary.deprecated,
    schema: buildSchemaPayload(caps),
  };
}

/** 取文本里第一个非空行（版本输出可能带空行或多行，界面只展示第一行） */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "");
  return line === undefined ? "" : line.trim();
}

/**
 * 把 presets.ini 的解析结果打包给界面。
 *
 * `staged` 的判定是"实际传入路径 ≠ 原路径"：只要启动器改动过这份文件
 * （非 ASCII 路径转存、或剔除了启动器自用段），界面就该提示用户"传给 llama-server 的
 * 不是你选的那个文件"。
 *
 * @param preset 解析结果；`null` 表示这次启动没有用 presets.ini
 * @param argPath 实际传给 `--models-preset` 的路径
 * @param originalPath 配置里写的原始路径（用于与 `argPath` 比较判断是否转存过）
 * @returns 界面用的 presets 载荷；`preset` 为 `null` 时直接返回 `null`
 */
export function buildPresetPayload(
  preset: PresetFile | null,
  argPath: string | null,
  originalPath: string | null,
): PresetPayload | null {
  if (preset === null) return null;
  const presetKeys = new Set<string>();
  const models: string[] = [];
  for (const [name, map] of preset.sections) {
    if (name === "defaults") continue;
    models.push(name);
    for (const key of map.keys()) presetKeys.add(key);
  }
  return {
    argPath: argPath ?? "",
    staged: argPath !== null && originalPath !== null && argPath !== originalPath,
    presetKeys: [...presetKeys],
    defaultModel: preset.defaultModel,
    models,
  };
}

/**
 * 把 `prepareLaunch` 的结果打包成界面用的预览载荷。
 *
 * 比 core 的结果多做两件事：拼出给人看的完整命令行；给决策表每行补上
 * 格式化好的 `argvText`（渲染层因此不必再实现一遍参数拼接）。
 *
 * @param prepared `prepareLaunch` 的结果
 * @param originalPresetPath 配置里写的 presets 原始路径，用于判断是否发生过转存
 * @returns 预览载荷，见 `PreviewPayload`
 */
export function buildPreviewPayload(prepared: PrepareResult, originalPresetPath: string | null): PreviewPayload {
  return {
    exe: prepared.exe,
    host: prepared.host,
    port: prepared.port,
    argv: prepared.argv,
    command: `${prepared.exe} ${formatArgv(prepared.argv)}`,
    env: prepared.env,
    // 决策表每行顺带给出格式化后的命令行片段，渲染层就不必再拼一次
    steps: prepared.steps.map((step) => ({
      ...step,
      argvText: step.argv.length > 0 ? formatArgv(step.argv) : "",
    })),
    warnings: prepared.warnings,
    preset: buildPresetPayload(prepared.presetFile, prepared.presetArgPath, originalPresetPath),
    preloadModelFile: prepared.preloadModelFile,
  };
}

/**
 * 把一行日志包成推送给界面的结构。
 *
 * `seq` 是自增序号：渲染层用它做 React key 与去重（避免"内容相同的两行"被折叠掉）。
 * `at` 取当前时间戳，因为 llama.cpp 自己那串时间戳是进程内的累计时间，不是墙上时钟。
 *
 * @param seq 自增序号（由会话维护）
 * @param at 毫秒时间戳
 * @param line 原始日志行
 * @param event `classify` 的分类结果
 * @returns 推送载荷，见 `LogPush`
 */
export function toLogPush(seq: number, at: number, line: string, event: LogEvent): LogPush {
  return { seq, at, line, kind: event.kind, level: event.level, metrics: event.metrics };
}

/**
 * 把 core 的启动报告转成 IPC 载荷。
 *
 * 结构上几乎是直通，唯一的手工处理是给 `suggestions` 做浅拷贝 ——
 * 避免界面侧对数组的改动污染 core 里那份诊断规则表（规则表是模块级常量，会被复用）。
 *
 * @param report `LlamaServer.start()` 的报告（`diagnosis` 字段结构与 core 的 `Diagnosis` 一致）
 * @returns 启动报告载荷，见 `StartReportPayload`
 */
export function buildStartReport(report: {
  pid: number | null;
  ready: boolean;
  waitedMs: number;
  state: string;
  note: string;
  diagnosis: { code: string; summary: string; suggestions: string[] } | null;
}): StartReportPayload {
  return {
    pid: report.pid,
    ready: report.ready,
    waitedMs: report.waitedMs,
    state: report.state,
    note: report.note,
    diagnosis:
      report.diagnosis === null
        ? null
        : {
            code: report.diagnosis.code,
            summary: report.diagnosis.summary,
            suggestions: [...report.diagnosis.suggestions],
          },
  };
}

/**
 * 推导 base URL，供界面显示与"打开网页"使用。
 *
 * 传了 `host`/`port` 就以它们为准（那通常是预览或启动**实际使用**的值，
 * 可能因端口顺延而不同于配置），否则退回配置里的值。
 *
 * @param config 当前配置
 * @param host 实际使用的监听地址（可选）
 * @param port 实际使用的端口（可选）
 * @returns 形如 `http://127.0.0.1:8080`；`0.0.0.0` 会被换成本机回环地址
 */
export function baseUrlFor(config: LauncherConfig, host?: string, port?: number): string {
  const resolvedHost = host ?? config.host ?? "127.0.0.1";
  const resolvedPort = port ?? (typeof config.port === "number" ? config.port : 8080);
  return baseUrlOf(resolvedHost, resolvedPort);
}
