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

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "");
  return line === undefined ? "" : line.trim();
}

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

export function toLogPush(seq: number, at: number, line: string, event: LogEvent): LogPush {
  return { seq, at, line, kind: event.kind, level: event.level, metrics: event.metrics };
}

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

export function baseUrlFor(config: LauncherConfig, host?: string, port?: number): string {
  const resolvedHost = host ?? config.host ?? "127.0.0.1";
  const resolvedPort = port ?? (typeof config.port === "number" ? config.port : 8080);
  return baseUrlOf(resolvedHost, resolvedPort);
}
