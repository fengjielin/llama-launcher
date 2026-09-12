import { useCallback, useEffect, useMemo, useState } from "react";
import { getApi } from "../api.ts";
import type { LauncherConfig } from "../../../core/types.ts";
import type { ProfileInfo } from "../../../core/profiles.ts";
import type { PrecheckReport } from "../../../core/precheck.ts";
import { isErrorPayload } from "../../../shared/ipc.ts";
import type {
  AppSettings,
  AppSettingsPayload,
  BootstrapPayload,
  DetectPayload,
  LogPush,
  MetricsPayload,
  PathSuggestions,
  PickKind,
  PreviewPayload,
  SchemaPayload,
  StartPayload,
  StatusPayload,
} from "../../../shared/ipc.ts";

/** 界面最多保留多少行日志（主进程侧另有一份 4000 条的缓冲，用于失败诊断） */
const LOG_LIMIT = 3000;
/** 配置变化后等多久才去重拼命令行 —— 防的是"每敲一个字符就请求一次" */
const PREVIEW_DEBOUNCE_MS = 350;
/** 服务运行时的状态轮询间隔（含 `/health` 检查） */
const STATUS_POLL_MS = 2000;

/**
 * 界面需要的全部状态与操作，由 {@link useLauncher} 返回。
 *
 * 拆成"数据字段 + 动作方法"两段：数据是只读快照，改动一律通过动作方法走
 * （`update` 改配置、`pick` 选路径、`save` 落盘…），这样状态变化的入口只有一个。
 */
export interface LauncherController {
  ready: boolean;
  bridgeMissing: boolean;
  busy: string | null;
  error: string | null;
  configPath: string;
  config: LauncherConfig | null;
  schema: SchemaPayload | null;
  warnings: string[];
  /** 中性通知（如「首次运行已生成默认配置」），界面上以 ℹ 展示而不是 ⚠ */
  notices: string[];
  /** 探测到的可一键填入路径（见 PathSuggestions）：输入框里的灰字只是示例，不是值 */
  suggestions: PathSuggestions;
  detect: DetectPayload | null;
  detectError: string | null;
  preview: PreviewPayload | null;
  previewError: string | null;
  lastStart: StartPayload | null;
  logs: LogPush[];
  status: StatusPayload | null;
  /** 指标快照（含历史序列）；还没打开过监控页时为 `null` */
  metrics: MetricsPayload | null;
  /** 配置档案列表 */
  profiles: ProfileInfo[];
  /** 档案目录（界面上展示，方便用户直接去拷文件） */
  profilesDir: string;
  /** 应用设置（开机自启、关闭窗口行为） */
  settings: AppSettingsPayload | null;
  /** 环境自检报告（驱动/CUDA 运行时/模型/端口） */
  precheck: PrecheckReport | null;
  update: (patch: Partial<LauncherConfig>) => void;
  refreshSchema: () => Promise<void>;
  /** 强制重跑环境自检（忽略主进程侧的缓存） */
  runPrecheckNow: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  openConfig: () => Promise<void>;
  save: () => Promise<void>;
  saveAs: () => Promise<void>;
  /** 从 presets.ini 导入模型预设到配置（预设以配置里的 presets 字段为准） */
  importPresets: () => Promise<void>;
  openWebUi: () => Promise<void>;
  pick: (key: string, kind: PickKind, title?: string) => Promise<void>;
  clearLogs: () => void;
  dismissError: () => void;
  /** 开关实时指标采样（切到监控页时开、离开时关） */
  watchMetrics: (active: boolean) => void;
  /** 把当前配置另存为一个档案 */
  saveProfileAs: (name: string) => Promise<void>;
  /** 载入档案（会把它设为当前配置） */
  loadProfile: (name: string) => Promise<void>;
  /** 删除档案 */
  removeProfile: (name: string) => Promise<void>;
  /** 在资源管理器里打开档案目录 */
  revealProfiles: () => Promise<void>;
  /** 修改应用设置 */
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

/**
 * 把任意抛出物转成可展示的字符串。
 *
 * 之所以不直接用 `String(err)`：`throw "字符串"` 与 `throw new Error(...)` 都会出现，
 * 这里统一成前者取 message、后者原样。
 */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 界面的唯一状态源。
 *
 * 数据流是单向的：config 变化 → 防抖后请主进程拼一次命令行 → 得到 preview（含决策表）；
 * 界面从不自己拼参数，所以"界面上看到的命令"和"实际启动的命令"永远是同一条。
 *
 * 内部有三条自动发生的线：初始化（拉配置 + 订阅推送 + 探测能力）、
 * 配置变化后的防抖重拼、以及服务运行时的状态轮询。
 *
 * @returns 状态与操作，见 {@link LauncherController}；在浏览器里直接打开（没有 preload 桥）时
 *   `bridgeMissing` 为 `true`，界面应改为提示用户用桌面壳启动
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
  /** 中性通知（不是问题），与 warnings 分开展示 */
  const [notices, setNotices] = useState<string[]>([]);
  const [detect, setDetect] = useState<DetectPayload | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [lastStart, setLastStart] = useState<StartPayload | null>(null);
  const [logs, setLogs] = useState<LogPush[]>([]);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [profilesDir, setProfilesDir] = useState("");
  const [settings, setSettings] = useState<AppSettingsPayload | null>(null);
  const [precheck, setPrecheck] = useState<PrecheckReport | null>(null);
  /** 主进程探测到的、可一键填入的路径（空串表示没探到） */
  const [suggestions, setSuggestions] = useState<PathSuggestions>({ modelsDir: "", presetPath: "", mainModel: "" });

  /**
   * 用一次初始化载荷整体替换本地状态（启动、打开配置后都走它）。
   *
   * 之所以整体替换而不是逐个 setState：这些载荷代表"换了一份配置"，
   * 逐字段更新容易出现"配置换了但参数表还是旧的"这种不一致。
   *
   * @param payload 主进程返回的初始化载荷
   */
  const reloadFrom = useCallback((payload: BootstrapPayload) => {
    setConfigPath(payload.configPath);
    setConfig(payload.config);
    setSchema(payload.schema);
    setWarnings(payload.warnings);
    // 中性通知（如"首次运行已生成配置"）：老载荷里可能没有这个字段，兜一下底
    setNotices(payload.notices ?? []);
    setSuggestions(payload.suggestions ?? { modelsDir: "", presetPath: "", mainModel: "" });
  }, []);

  /**
   * 重新探测 llama-server 能力，并用结果刷新参数表。
   *
   * 两种失败要分开看：`isErrorPayload` 是传输层失败（如找不到 exe，整次调用返回 `{ error }`）；
   * `result.ok === false` 是探测跑通了但没解析出参数（此时 `failure` 有说明）。
   * 后者仍要用返回的参数表（全部标为"未探测"），否则界面会停留在旧的支持情况上。
   */
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

  /** 重新拉档案列表（保存/删除之后调用，保证列表与磁盘一致） */
  const refreshProfiles = useCallback(async () => {
    if (api === null) return;
    const payload = await api.listProfiles();
    setProfiles(payload.profiles);
    setProfilesDir(payload.dir);
  }, [api]);

  // ---- 初始化：拉配置 + 订阅推送 + 探测能力 ----
  // `disposed` 用于防止"请求还没回来组件就卸载/重挂"造成的过期 setState；
  // 订阅的清理函数同样在卸载时执行，因此 React StrictMode 的双次调用是安全的
  // （不会留下两份监听，日志也就不会重复）。
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
        if (disposed) return;

        // 档案与应用设置：都不重要到需要阻塞界面，失败就保持空状态
        await refreshProfiles();
        if (disposed) return;
        setSettings(await api.getSettings());
        if (disposed) return;

        // 环境自检：开机就跑一遍，这样「自检」页与标签页角标一开始就有内容
        setPrecheck(await api.precheck(false));
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
    // 指标推送：载荷里已带完整历史序列，直接替换即可
    const offMetrics = api.onMetrics((payload) => setMetrics(payload));

    return () => {
      disposed = true;
      offLog();
      offState();
      offMetrics();
      // 卸载时务必关掉采样，否则会一直每秒钟起一个 nvidia-smi 进程
      void api.metricsWatch(false);
    };
  }, [api, reloadFrom, refreshSchema, refreshProfiles]);

  // ---- 配置变化 → 防抖后重拼命令行 ----
  // busy 不为空时（正在启动/停止/保存）先不重拼：那期间配置本来就不会变，
  // 少发一次 IPC，也避免与启动流程抢时序。
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
  // 只在进程确实在跑时轮询；轮询失败被静默忽略（下一次轮询会再试，
  // 不必因为一次抖动就在界面上弹错误）。
  useEffect(() => {
    if (api === null || status?.running !== true) return;
    const handle = setInterval(() => {
      void api.status().then(setStatus).catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => clearInterval(handle);
  }, [api, status?.running]);

  /**
   * 动作的统一包装：置忙 → 清旧错误 → 执行 → 捕获异常 → 解除忙碌。
   *
   * 好处是每个动作只需写"成功路径"，异常与忙碌状态的收尾不会漏；
   * `label` 会显示在状态栏上（"进行中：start"），让用户知道卡在哪一步。
   *
   * @param label 动作名，用于界面提示
   * @param fn 实际要执行的操作；抛出的异常会被转成 `error` 展示，不会冒泡
   */
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

  /**
   * 局部更新配置（表单每次改动都走它）。
   *
   * @param patch 要覆盖的字段；配置还没加载完（`null`）时什么也不做
   */
  const update = useCallback((patch: Partial<LauncherConfig>) => {
    setConfig((prev) => (prev === null ? prev : { ...prev, ...patch }));
  }, []);

  /**
   * 启动服务。
   *
   * 结果同时喂给三处：`lastStart`（失败时要展示诊断结论）、`preview`（端口顺延后命令可能变了）、
   * `status`（刷新状态栏）。**失败不抛异常** —— 主进程把"起不来"编码在载荷里返回。
   */
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

  /** 停止服务并刷新状态（停止本身不返回业务信息，只需要最新状态） */
  const stop = useCallback(
    () =>
      run("stop", async () => {
        if (api === null) return;
        await api.stop();
        setStatus(await api.status());
      }),
    [api, run],
  );

  /**
   * 打开另一个配置文件。
   *
   * 用户取消（`canceled`）视为什么都没发生；换配置后要重探一次能力 ——
   * 新配置的 `llama_dir` 可能与当前不同，参数表必须跟着换。
   */
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

  /**
   * 从 presets.ini 导入模型预设（并进配置的 `presets` 字段）。
   *
   * 导入成功后主进程已经写盘，所以这里整体刷新一次载荷 ——
   * 与"打开配置"同样的道理：预设变了，参数接管关系与决策表都得跟着重算。
   */
  const importPresets = useCallback(
    () =>
      run("importPresets", async () => {
        if (api === null) return;
        const result = await api.importPresets();
        if (result.canceled) return;
        if (result.payload !== null) reloadFrom(result.payload);
        if (result.warnings.length > 0) setWarnings(result.warnings);
        await refreshSchema();
      }),
    [api, refreshSchema, reloadFrom, run],
  );

  /** 保存到当前配置文件；保存会重新归一化，所以要用返回的告警刷新提醒区 */
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

  /** 另存为：只有真的写盘成功才把界面上的配置路径切过去（取消则保持原路径） */
  const saveAs = useCallback(
    () =>
      run("saveAs", async () => {
        if (api === null || config === null) return;
        const result = await api.saveConfigAs(config);
        if (!result.canceled && result.path !== null) setConfigPath(result.path);
      }),
    [api, config, run],
  );

  /** 用系统浏览器打开 llama-server 自带的 WebUI（地址由主进程按实际端口推导） */
  const openWebUi = useCallback(
    () =>
      run("openWebUi", async () => {
        if (api === null) return;
        const result = await api.openWebUi();
        if (!result.ok) setError("打开网页失败，请确认服务已经启动");
      }),
    [api, run],
  );

  /**
   * 弹系统对话框选一个路径，选中后写回配置的对应字段。
   *
   * @param key 配置字段名（如 `main_model`、`models_dir`）
   * @param kind 选择类型，决定对话框是选文件还是选目录、以及文件过滤器
   * @param title 对话框标题（可选）
   */
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

  /** 强制重跑环境自检（主进程侧有缓存，force 才会真的重新采集） */
  const runPrecheckNow = useCallback(
    () =>
      run("precheck", async () => {
        if (api === null) return;
        setPrecheck(await api.precheck(true));
      }),
    [api, run],
  );

  /** 清空界面上的日志（只影响展示，主进程的诊断缓冲不动） */
  const clearLogs = useCallback(() => setLogs([]), []);
  /** 关掉顶部的错误横幅 */
  const dismissError = useCallback(() => setError(null), []);

  /**
   * 开关实时指标采样。
   *
   * 打开时顺手拉一次快照，避免监控面板先空等一秒才有数据；
   * 关闭时只停采样不清历史 —— 切回来还能看到之前的曲线。
   */
  const watchMetrics = useCallback(
    (active: boolean) => {
      if (api === null) return;
      void api.metricsWatch(active);
      if (active) {
        void api.metricsSnapshot().then(setMetrics).catch(() => undefined);
      }
    },
    [api],
  );

  /**
   * 把**当前界面上的配置**另存为一个档案。
   *
   * 传的是内存里的配置而不是磁盘上的那份，因此"改完参数直接存成档案"也能生效。
   * 同名会覆盖（档案名会被主进程规整成安全文件名）。
   */
  const saveProfileAs = useCallback(
    (name: string) =>
      run("saveProfile", async () => {
        if (api === null || config === null) return;
        const result = await api.saveProfile(name, config);
        setProfiles(result.profiles);
      }),
    [api, config, run],
  );

  /** 载入档案：它会被设为当前配置，因此要重新探测能力并刷新列表 */
  const loadProfile = useCallback(
    (name: string) =>
      run("loadProfile", async () => {
        if (api === null) return;
        const result = await api.loadProfile(name);
        if (result.payload !== null) reloadFrom(result.payload);
        if (result.warnings.length > 0) setWarnings(result.warnings);
        await refreshSchema();
        await refreshProfiles();
      }),
    [api, refreshProfiles, refreshSchema, reloadFrom, run],
  );

  /** 删除档案（主进程侧是幂等的，重复删不报错） */
  const removeProfile = useCallback(
    (name: string) =>
      run("removeProfile", async () => {
        if (api === null) return;
        const result = await api.deleteProfile(name);
        setProfiles(result.profiles);
      }),
    [api, run],
  );

  /** 在资源管理器里打开档案目录（方便拷给别的机器） */
  const revealProfiles = useCallback(
    () =>
      run("revealProfiles", async () => {
        if (api === null) return;
        const result = await api.revealProfiles();
        setProfilesDir(result.dir);
      }),
    [api, run],
  );

  /** 修改应用设置（开机自启 / 关闭窗口行为），返回值即最新设置 */
  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) =>
      run("updateSettings", async () => {
        if (api === null) return;
        setSettings(await api.setSettings(patch));
      }),
    [api, run],
  );

  return {
    ready,
    bridgeMissing,
    busy,
    error,
    configPath,
    config,
    schema,
    warnings,
    notices,
    suggestions,
    detect,
    detectError,
    preview,
    previewError,
    lastStart,
    logs,
    status,
    metrics,
    profiles,
    profilesDir,
    settings,
    precheck,
    update,
    refreshSchema,
    runPrecheckNow,
    start,
    stop,
    openConfig,
    save,
    saveAs,
    importPresets,
    openWebUi,
    pick,
    clearLogs,
    dismissError,
    watchMetrics,
    saveProfileAs,
    loadProfile,
    removeProfile,
    revealProfiles,
    updateSettings,
  };
}
