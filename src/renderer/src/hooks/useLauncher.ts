import { useCallback, useEffect, useMemo, useState } from "react";
import type { LauncherConfig } from "../../../core/types.ts";
import { isErrorPayload } from "../../../shared/ipc.ts";
import type {
  BootstrapPayload,
  DetectPayload,
  LogPush,
  PickKind,
  PreviewPayload,
  SchemaPayload,
  StartPayload,
  StatusPayload,
} from "../../../shared/ipc.ts";
import { getApi } from "../api.ts";

const LOG_LIMIT = 3000;
const PREVIEW_DEBOUNCE_MS = 350;
const STATUS_POLL_MS = 2000;

export interface LauncherController {
  ready: boolean;
  bridgeMissing: boolean;
  busy: string | null;
  error: string | null;
  configPath: string;
  config: LauncherConfig | null;
  schema: SchemaPayload | null;
  warnings: string[];
  detect: DetectPayload | null;
  detectError: string | null;
  preview: PreviewPayload | null;
  previewError: string | null;
  lastStart: StartPayload | null;
  logs: LogPush[];
  status: StatusPayload | null;
  update: (patch: Partial<LauncherConfig>) => void;
  refreshSchema: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  openConfig: () => Promise<void>;
  save: () => Promise<void>;
  saveAs: () => Promise<void>;
  migrate: () => Promise<void>;
  openWebUi: () => Promise<void>;
  pick: (key: string, kind: PickKind, title?: string) => Promise<void>;
  clearLogs: () => void;
  dismissError: () => void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 界面的唯一状态源。
 *
 * 数据流是单向的：config 变化 → 防抖后请主进程拼一次命令行 → 得到 preview（含决策表）；
 * 界面从不自己拼参数，所以"界面上看到的命令"和"实际启动的命令"永远是同一条。
 */
export function useLauncher(): LauncherController {
  const api = useMemo(() => getApi(), []);
  const bridgeMissing = api === null;

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [config, setConfig] = useState<LauncherConfig | null>(null);
  const [schema, setSchema] = useState<SchemaPayload | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [detect, setDetect] = useState<DetectPayload | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [lastStart, setLastStart] = useState<StartPayload | null>(null);
  const [logs, setLogs] = useState<LogPush[]>([]);
  const [status, setStatus] = useState<StatusPayload | null>(null);

  const reloadFrom = useCallback((payload: BootstrapPayload) => {
    setConfigPath(payload.configPath);
    setConfig(payload.config);
    setSchema(payload.schema);
    setWarnings(payload.warnings);
  }, []);

  const refreshSchema = useCallback(async () => {
    if (api === null) return;
    const result = await api.detect();
    if (isErrorPayload(result)) {
      setDetectError(result.error);
      return;
    }
    setDetect(result);
    setSchema(result.schema);
    setDetectError(result.ok ? null : (result.failure ?? null));
  }, [api]);

  // ---- 初始化：拉配置 + 订阅推送 + 探测能力 ----
  useEffect(() => {
    if (api === null) {
      setReady(true);
      return;
    }
    let disposed = false;

    void (async () => {
      try {
        const boot = await api.bootstrap();
        if (disposed) return;
        reloadFrom(boot);

        const recent = await api.recentLogs();
        if (disposed) return;
        if (recent.length > 0) setLogs(recent.slice(-LOG_LIMIT));

        const current = await api.status();
        if (disposed) return;
        setStatus(current);

        await refreshSchema();
      } catch (err) {
        if (!disposed) setError(message(err));
      } finally {
        if (!disposed) setReady(true);
      }
    })();

    const offLog = api.onLog((entry) => {
      setLogs((prev) => {
        const next = prev.length >= LOG_LIMIT ? prev.slice(prev.length - LOG_LIMIT + 1) : [...prev];
        next.push(entry);
        return next;
      });
    });
    const offState = api.onState((push) => {
      setStatus((prev) => (prev === null ? prev : { ...prev, state: push.state, note: push.note }));
    });

    return () => {
      disposed = true;
      offLog();
      offState();
    };
  }, [api, reloadFrom, refreshSchema]);

  // ---- 配置变化 → 防抖后重拼命令行 ----
  useEffect(() => {
    if (api === null || config === null || busy !== null) return;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.preview(config);
          if (isErrorPayload(result)) {
            setPreviewError(result.error);
          } else {
            setPreview(result);
            setPreviewError(null);
          }
        } catch (err) {
          setPreviewError(message(err));
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [api, config, busy]);

  // ---- 运行时轮询状态（含 /health）----
  useEffect(() => {
    if (api === null || status?.running !== true) return;
    const handle = setInterval(() => {
      void api.status().then(setStatus).catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => clearInterval(handle);
  }, [api, status?.running]);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const update = useCallback((patch: Partial<LauncherConfig>) => {
    setConfig((prev) => (prev === null ? prev : { ...prev, ...patch }));
  }, []);

  const start = useCallback(
    () =>
      run("start", async () => {
        if (api === null || config === null) return;
        const result = await api.start(config);
        if (isErrorPayload(result)) {
          setError(result.error);
          return;
        }
        setLastStart(result);
        setPreview(result);
        setWarnings(result.warnings);
        setStatus(await api.status());
      }),
    [api, config, run],
  );

  const stop = useCallback(
    () =>
      run("stop", async () => {
        if (api === null) return;
        await api.stop();
        setStatus(await api.status());
      }),
    [api, run],
  );

  const openConfig = useCallback(
    () =>
      run("openConfig", async () => {
        if (api === null) return;
        const result = await api.openConfig();
        if (result.canceled || result.payload === null) return;
        reloadFrom(result.payload);
        await refreshSchema();
      }),
    [api, refreshSchema, reloadFrom, run],
  );

  const save = useCallback(
    () =>
      run("save", async () => {
        if (api === null || config === null) return;
        const result = await api.saveConfig(config);
        setWarnings(result.warnings);
        setError(null);
      }),
    [api, config, run],
  );

  const saveAs = useCallback(
    () =>
      run("saveAs", async () => {
        if (api === null || config === null) return;
        const result = await api.saveConfigAs(config);
        if (!result.canceled && result.path !== null) setConfigPath(result.path);
      }),
    [api, config, run],
  );

  const migrate = useCallback(
    () =>
      run("migrate", async () => {
        if (api === null) return;
        const result = await api.migrateConfig();
        if (result.canceled) return;
        if (result.payload !== null) reloadFrom(result.payload);
        if (result.warnings.length > 0) setWarnings(result.warnings);
        await refreshSchema();
      }),
    [api, refreshSchema, reloadFrom, run],
  );

  const openWebUi = useCallback(
    () =>
      run("openWebUi", async () => {
        if (api === null) return;
        const result = await api.openWebUi();
        if (!result.ok) setError("打开网页失败，请确认服务已经启动");
      }),
    [api, run],
  );

  const pick = useCallback(
    (key: string, kind: PickKind, title?: string) =>
      run("pick", async () => {
        if (api === null || config === null) return;
        const current = config[key];
        const result = await api.pickPath({
          kind,
          title,
          defaultPath: typeof current === "string" ? current : undefined,
        });
        if (result.canceled || result.path === null) return;
        update({ [key]: result.path });
      }),
    [api, config, run, update],
  );

  const clearLogs = useCallback(() => setLogs([]), []);
  const dismissError = useCallback(() => setError(null), []);

  return {
    ready,
    bridgeMissing,
    busy,
    error,
    configPath,
    config,
    schema,
    warnings,
    detect,
    detectError,
    preview,
    previewError,
    lastStart,
    logs,
    status,
    update,
    refreshSchema,
    start,
    stop,
    openConfig,
    save,
    saveAs,
    migrate,
    openWebUi,
    pick,
    clearLogs,
    dismissError,
  };
}
