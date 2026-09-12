#!/usr/bin/env node
/**
 * 打包入口：在交给 electron-builder 之前，先把「产物目录被占用」这件事处理掉。
 *
 * ## 为什么需要这一层
 *
 * 链路上每一步都在 electron-builder 源码里核对过（app-builder-lib/out/electron/ElectronFramework.js）：
 *
 *   1. `electronDist` 指向一个**已解压的目录**时，它走的是 "custom unpacked Electron distribution" 分支：
 *        await emptyDir(prepareOptions.appOutDir);     // ← ① ┐
 *        await copyDir(source, destination, {...});    // ← ② │ 这两步是硬失败点
 *        return false;                                 // ← ③ ┘
 *   2. ② 是**全量复制**，会把 Electron 自带的 `resources/default_app.asar` 一起复制进产物
 *      （那是「没给 app 时启动的空应用」，我们自带 app，用不到它）。
 *   3. ③ 返回 `false` 表示 `isFullCleanup = false`，于是 `cleanupAfterUnpack()` 里那两行
 *      `unlinkIfExists(产物里的 default_app.asar)` / `unlinkIfExists(产物里的 version)` **被整个跳过**
 *      —— 也就是说用自定义 electronDist 时，那个 asar 永远留在产物里。
 *   4. 下一次打包，① 的 `emptyDir(appOutDir)` 要先清空上一次的产物。这一步**不吞错误**：
 *      一旦那个残留的 `.asar` 被别的进程占用，整个打包就以
 *        EBUSY: resource busy or locked, unlink '...\resources\default_app.asar'
 *      中断。本机实测：两个废弃输出目录里残留的 4 个 `.asar` 全部长期锁定
 *      （可正常读取，但改不了名、删不掉），而同一目录下新建的普通文件都能正常删除 ——
 *      说明是本机上某个常驻进程（安全软件 / 文件索引）在解析 `.asar` 归档并持有句柄。
 *
 * ## 对策
 *
 * 不跟那个进程较劲，而是**让产物里根本不出现 `.asar`**：
 *
 *   - `default_app.asar`：本脚本在打包前准备一份 `.electron-dist/` 发行目录镜像，
 *     **跳过** `resources/default_app.asar`，其余文件用**硬链接**指过去（NTFS 硬链接不占额外空间，
 *     对 electron-builder 的复制来说和普通文件完全一样）。之所以不直接删 `node_modules` 里那个源文件：
 *     它自己也常被锁住，删不掉；而硬链接镜像只需要读权限。
 *   - `app.asar`：配置里保持 `asar: false`（见 electron-builder.yml），app 以 `resources/app/` 明文目录存在。
 *
 * 于是 ①② 两步都不会碰到任何 `.asar`，打包不再取决于「外部进程此刻有没有攥着那个文件」。
 *
 * ## 兜底
 *
 * 万一还有别的文件被占用（例如刚生成的 exe 正被杀软扫描），清理失败时本次打包自动改用带时间戳的
 * 备用输出目录，而不是让整个打包失败，并打印占用文件与两条出路。
 *
 * ## 用法
 *
 * 一般由 package.json 的 package / package:portable 调起，参数原样透传给 electron-builder：
 *
 * ```powershell
 * node scripts/package.mjs --win --dir      # 免安装目录
 * node scripts/package.mjs --win portable   # 单文件便携版
 * node scripts/package.mjs --check          # 只做诊断，不打包
 * ```
 *
 * 环境变量：
 *   `LLAMA_PACKAGE_OUT`  指定输出目录（默认项目内的 `dist/`），便于把产物放到工作区之外。
 *   `LLAMA_PACKAGE_TOUCH=1`  打包后把产物里所有文件/目录的时间戳统一成构建时间 ——
 *     Electron 自带的文件（dll / pak / locales / electron.exe）时间戳是 1980-01-01
 *     （官方 zip 的 MS-DOS 时间字段写的是最小值，可复现构建的常规做法），看目录时会显得很怪。
 *     它不影响运行，所以默认不动；想统一就打开这个开关。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 项目根目录（本脚本在 scripts/ 下）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** electron-builder 的入口脚本：直接 node 执行，避免 Windows 上 .cmd 的引号问题。 */
const BUILDER_CLI = path.join(ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js");

/** 上一次打包的产物目录（appOutDir），也是唯一需要预先清理的地方。 */
const APP_OUT_NAME = "win-unpacked";

/** 已安装的 Electron 发行目录（源）。 */
const ELECTRON_DIST = path.join(ROOT, "node_modules", "electron", "dist");

/** 给打包用的过滤镜像目录（见文件头「对策」）。 */
const ELECTRON_DIST_MIRROR = path.join(ROOT, ".electron-dist");

/** 镜像里要跳过的文件（相对发行目录），也就是本次问题的元凶。 */
const SKIPPED_IN_MIRROR = [path.join("resources", "default_app.asar")];

/** 镜像的版本标记：Electron 换版本后镜像要重建。 */
const MIRROR_MARKER = path.join(ELECTRON_DIST_MIRROR, ".llama-mirror-source");

/** 上次打包留下的安装包/便携版文件名前缀，顺带清掉，避免旧 exe 被杀软扫描时挡住写入。 */
const ARTIFACT_PREFIX = "llama-launcher-";

/**
 * 产物目录里"跑过应用就会生成"的文件。
 *
 * 打包前会清空 `win-unpacked`，而**用户很可能就是在这里直接运行 exe**（便携版设计如此：
 * 配置与数据都放在 exe 旁边）。清掉它们等于把用户的配置一起删了 —— 应用下次启动会重新
 * 探测并生成一份默认配置，于是出现"我明明改过的值怎么又变回去了"。
 * 实测踩过：把预加载模型、每模型的 ctx / 输出上限都改好之后重建一次，产物里那份配置
 * 被清掉、应用重新生成，命令又回到了旧值（`-c 16384 -n 8192`），而项目根目录的配置
 * 打包版根本不读。
 *
 * 所以这些文件在清理前先记下来，构建成功后原样放回。
 */
const RUNTIME_FILES = ["llama-launcher.json", path.join("data", "llama-launcher-settings.json")];

/**
 * 把产物目录里已有的运行时文件读进内存（构建后放回）。
 *
 * @param {string} appOutDir 产物目录（`<输出>/win-unpacked`）
 * @returns {Array<{rel: string, text: string}>} 记下的文件（可能为空）
 */
function snapshotRuntimeFiles(appOutDir) {
  const kept = [];
  for (const rel of RUNTIME_FILES) {
    const abs = path.join(appOutDir, rel);
    try {
      if (fs.existsSync(abs)) kept.push({ rel, text: fs.readFileSync(abs, "utf8") });
    } catch {
      // 读不出来就算了：这只是"尽量别删用户的东西"，不该阻断打包
    }
  }
  return kept;
}

/**
 * 把记下的运行时文件放回新产物目录（已存在的不覆盖 —— 以用户当前的为准）。
 *
 * @param {string} appOutDir 新的产物目录
 * @param {Array<{rel: string, text: string}>} kept {@link snapshotRuntimeFiles} 的结果
 * @returns {string[]} 实际放回的文件（相对路径）
 */
function restoreRuntimeFiles(appOutDir, kept) {
  const restored = [];
  for (const { rel, text } of kept) {
    const abs = path.join(appOutDir, rel);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (!fs.existsSync(abs)) {
        fs.writeFileSync(abs, text, "utf8");
        restored.push(rel);
      }
    } catch {
      // 同上：放不回去只影响"要不要重新探测"，不影响产物本身
    }
  }
  return restored;
}

/**
 * 读取一个"开关型"环境变量。
 *
 * @param {string} name 变量名
 * @returns {boolean} 值为 1 / true / yes / on（忽略大小写与首尾空格）时为 `true`
 */
function envFlag(name) {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * 递归把一棵目录树里所有文件与目录的时间戳统一成同一个时刻。
 *
 * 为什么需要它：产物里 Electron 自带的那些文件（`electron.exe`、`*.dll`、`*.pak`、`locales/`）
 * 时间戳是 **1980-01-01**，看着很怪。原因在源头：Electron 官方 zip 的中央目录把全部 75 个条目
 * 的时间字段都写成 MS-DOS 时间的最小值（`dosDate=0x0021 dosTime=0x0000` = 1980-01-01 00:00:00，
 * 按 UTC 解释、在 UTC+8 显示成 08:00）—— 这是可复现构建的常规做法，让同一版本的 zip 字节恒定。
 * 解压、硬链接镜像、electron-builder 复制都会**保留 mtime**，于是 1980 一路传到产物里。
 *
 * 这既不影响运行，也不影响 Electron 的任何校验；只有"目录里新旧混杂看着乱"和
 * "按 mtime 做增量的同步/备份工具把它当极旧文件"这两点小麻烦，所以做成**默认关闭**的开关
 * （`LLAMA_PACKAGE_TOUCH=1`）。
 *
 * @param {string} dir 目标目录
 * @param {Date} when 要统一成的时刻
 * @returns {{files: number, dirs: number, failed: number}} 统计（`failed` 通常是正被占用的文件）
 */
function touchTree(dir, when) {
  const stats = { files: 0, dirs: 0, failed: 0 };
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      stats.failed += 1;
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        // 先动文件再动目录：这样目录的 mtime 是"最后一次内容变更"的语义，不会被自己前面的写入破坏
        try {
          fs.utimesSync(full, when, when);
          stats.dirs += 1;
        } catch {
          stats.failed += 1;
        }
        continue;
      }
      try {
        fs.utimesSync(full, when, when);
        stats.files += 1;
      } catch {
        stats.failed += 1;
      }
    }
  };
  walk(dir);
  return stats;
}

/**
 * 按需打印一行进度。
 * @param {string} msg 要打印的内容（自带前缀）。
 */
function say(msg) {
  console.log(msg);
}

/**
 * 递归删除目录，并把「删不掉的东西」逐条收集起来。
 *
 * 不用 `fs.rmSync(dir, {recursive: true})` 的原因：它一遇到 EBUSY 就整体抛错，
 * 且不会告诉我们是哪几个文件被占用 —— 而这里最需要的信息恰恰就是那几行。
 *
 * @param {string} dir 目标目录（不存在时视为已清理干净）。
 * @returns {{removed: number, blocked: Array<{path: string, code: string, isDir: boolean}>}}
 *   `removed` 为成功删除的条目数；`blocked` 为删除失败的条目（含错误码）。
 */
function removeTree(dir) {
  const blocked = [];
  let removed = 0;

  /** @param {string} current 当前遍历到的目录。 */
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      // 目录不存在 = 本来就干净；其它错误（比如无权限）如实记下来。
      if (err.code !== "ENOENT") blocked.push({ path: current, code: err.code ?? "?", isDir: true });
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          fs.rmSync(full, { force: true, maxRetries: 3, retryDelay: 120 });
          removed += 1;
        } catch (err) {
          blocked.push({ path: full, code: err.code ?? "?", isDir: false });
        }
      }
    }
    try {
      // 子项没删干净时这里也会失败，但那些子项已经记过了，不必重复报。
      fs.rmdirSync(current);
    } catch (err) {
      if (err.code !== "ENOENT" && !blocked.some((b) => b.path === current || b.path.startsWith(current + path.sep))) {
        blocked.push({ path: current, code: err.code ?? "?", isDir: true });
      }
    }
  };

  if (!fs.existsSync(dir)) return { removed, blocked };
  walk(dir);
  return { removed, blocked };
}

/**
 * 生成「被占用文件的说明」文本。
 *
 * @param {Array<{path: string, code: string, isDir: boolean}>} blocked `removeTree` 收集到的失败条目。
 * @param {number} [limit] 最多列几条，默认 5。
 * @returns {string[]} 每行一条，供调用方直接打印。
 */
function describeBlocked(blocked, limit = 5) {
  const lines = blocked
    .slice(0, limit)
    .map((b) => `      ${path.relative(ROOT, b.path) || b.path}  (${b.code})`);
  if (blocked.length > limit) lines.push(`      …还有 ${blocked.length - limit} 个`);
  return lines;
}

/**
 * 读取已安装 Electron 的版本号，用作镜像的有效性标记。
 *
 * @returns {string} 形如 `44.3.0`；读不到时返回 `unknown`（此时镜像每次都会重建）。
 */
function readElectronVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "electron", "package.json"), "utf8"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

/**
 * 把一份发行目录镜像到目标目录：保留目录结构，文件优先用硬链接，跳过黑名单文件。
 *
 * 硬链接的好处是**不占额外空间**（367 MB 的 Electron 发行目录直接镜像过去也只有目录项的开销），
 * 而且对读取方而言与普通文件完全等价 —— electron-builder 的 `copyDir()` 就是逐个读文件再写出，
 * 所以镜像不会被它「原样复制成链接」。链接失败时（极端情况下跨卷）退化为真实复制。
 *
 * @param {string} src 源目录绝对路径。
 * @param {string} dst 目标目录绝对路径（调用方保证其父目录存在）。
 * @param {Set<string>} skip 需要跳过的相对路径集合（`path.relative` 的形态）。
 * @returns {{linked: number, copied: number, skipped: string[]}} 统计信息。
 */
function mirrorDir(src, dst, skip) {
  const stats = { linked: 0, copied: 0, skipped: [] };
  fs.mkdirSync(dst, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const rel = path.relative(ELECTRON_DIST, from);
    if (skip.has(rel)) {
      stats.skipped.push(rel);
      continue;
    }
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      const sub = mirrorDir(from, to, skip);
      stats.linked += sub.linked;
      stats.copied += sub.copied;
      stats.skipped.push(...sub.skipped);
      continue;
    }
    try {
      fs.linkSync(from, to);
      stats.linked += 1;
    } catch {
      fs.copyFileSync(from, to);
      stats.copied += 1;
    }
  }
  return stats;
}

/**
 * 准备给打包用的 Electron 发行目录镜像（幂等）。
 *
 * 已经存在且源版本没变时直接复用；否则删除重建。删除失败的残留不会影响正确性 ——
 * 镜像里没有 `.asar`，剩下的普通文件在本机都能正常删除。
 *
 * @returns {{reused: boolean, dir: string, version: string, stats: object|null, blocked: Array<object>}}
 *   `reused` 为 true 时表示沿用已有镜像，`stats` 为 null。
 */
function ensureElectronDistMirror() {
  const version = readElectronVersion();
  if (fs.existsSync(MIRROR_MARKER)) {
    try {
      if (fs.readFileSync(MIRROR_MARKER, "utf8").trim() === version) {
        return { reused: true, dir: ELECTRON_DIST_MIRROR, version, stats: null, blocked: [] };
      }
    } catch {
      /* 标记读不了就重建 */
    }
  }

  const cleared = removeTree(ELECTRON_DIST_MIRROR);
  const skip = new Set(SKIPPED_IN_MIRROR);
  const stats = mirrorDir(ELECTRON_DIST, ELECTRON_DIST_MIRROR, skip);
  fs.writeFileSync(
    MIRROR_MARKER,
    `${version}\n`,
    "utf8",
  );
  return { reused: false, dir: ELECTRON_DIST_MIRROR, version, stats, blocked: cleared.blocked };
}

/**
 * 选定本次打包的输出目录，并尽量把它清理干净。
 *
 * 顺序：`LLAMA_PACKAGE_OUT` → 项目内 `dist/`。首选目录的 `win-unpacked` 清不掉时，
 * 自动改用带时间戳的备用目录（`<首选>-fallback-<yyyyMMddHHmmss>`），
 * 因为「清不掉」意味着这个路径在本次以及后续每次打包都会失败，硬顶没有意义。
 *
 * @param {string} preferred 首选输出目录的绝对路径。
 * @returns {{dir: string, fallback: boolean, blocked: Array<object>, removed: number}}
 *   `dir` 为最终选定的绝对路径；`fallback` 表示是否退到了备用目录。
 */
function prepareOutputDir(preferred) {
  // 顺带清掉上次的安装包（只删我们自己的命名前缀，避免误删目录里的其它东西）。
  if (fs.existsSync(preferred)) {
    for (const name of fs.readdirSync(preferred)) {
      if (name.startsWith(ARTIFACT_PREFIX) && name.endsWith(".exe")) {
        try {
          fs.rmSync(path.join(preferred, name), { force: true, maxRetries: 3, retryDelay: 120 });
        } catch {
          /* 删不掉就交给后面判断，不在这里报错 */
        }
      }
    }
  }

  const first = removeTree(path.join(preferred, APP_OUT_NAME));
  if (first.blocked.length === 0) return { dir: preferred, fallback: false, blocked: [], removed: first.removed };

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const alternate = `${preferred}-fallback-${stamp}`;
  const second = removeTree(path.join(alternate, APP_OUT_NAME));
  return { dir: alternate, fallback: true, blocked: first.blocked, removed: first.removed + second.removed };
}

/**
 * 打印「输出目录被占用」的完整说明：现象、原因、两条出路。
 *
 * @param {string} preferred 首选（清不掉的）输出目录。
 * @param {string} chosen 本次实际使用的输出目录。
 * @param {Array<object>} blocked 清不掉的条目。
 */
function explainFallback(preferred, chosen, blocked) {
  say("");
  say("  ⚠ 首选输出目录里有文件被其它进程占用，清不掉：");
  for (const line of describeBlocked(blocked)) say(line);
  say("");
  say("    占用者通常是安全软件或文件索引工具 —— 本机在跑火绒（HipsDaemon / HipsTray），");
  say("    它会解析刚生成的产物并攥着句柄；Everything 开了内容索引也会这样。");
  say("    本次已自动改用备用输出目录：");
  say(`      ${path.relative(ROOT, chosen) || chosen}`);
  say("");
  say("    想回到原来的目录：重启一次电脑（句柄随之释放）后删掉下面的残留即可 ——");
  say(`      ${path.relative(ROOT, preferred) || preferred}`);
  say("    更省事的长期做法：把本项目目录与输出目录加进火绒的「信任区」，");
  say("    或在 Everything 里关掉内容索引。");
  say("");
}

/**
 * 主流程：准备发行目录镜像 → 选并清理输出目录 → 调 electron-builder → 报告产物路径。
 *
 * @returns {number} 进程退出码（0 成功；`--check` 模式下固定为 0）。
 */
function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check");
  const builderArgs = argv.filter((a) => a !== "--check");

  say("▸ 准备给打包用的 Electron 发行目录");
  const mirror = ensureElectronDistMirror();
  if (mirror.reused) {
    say(`  · 复用 .electron-dist（Electron ${mirror.version}）`);
  } else {
    const skipped = mirror.stats.skipped.length > 0 ? `，跳过 ${mirror.stats.skipped.join("、")}` : "";
    say(`  · 已生成 .electron-dist（Electron ${mirror.version}）：`
      + `硬链接 ${mirror.stats.linked} 个、复制 ${mirror.stats.copied} 个${skipped}`);
    if (mirror.blocked.length > 0) {
      say("  ⚠ 重建镜像时有旧文件没能删掉（不影响本次打包）：");
      for (const line of describeBlocked(mirror.blocked)) say(line);
    }
  }

  const preferred = path.resolve(process.env.LLAMA_PACKAGE_OUT || path.join(ROOT, "dist"));
  say(`▸ 检查输出目录 ${path.relative(ROOT, preferred) || preferred}`);
  // 清理之前先记下"跑过应用才会有的文件"，构建成功后放回（否则用户的配置会被一起删掉）
  const keptRuntime = snapshotRuntimeFiles(path.join(preferred, APP_OUT_NAME));
  if (keptRuntime.length > 0) {
    say(`  · 发现上次运行留下的 ${keptRuntime.map((f) => f.rel).join("、")}，构建后会原样放回`);
    say("    （便携版把配置放在 exe 旁边；如果打算长期在这里跑，建议把整个 win-unpacked 拷到别处）");
  }
  const picked = prepareOutputDir(preferred);
  if (picked.fallback) explainFallback(preferred, picked.dir, picked.blocked);
  else say(`  · 已清理 ${path.relative(ROOT, path.join(picked.dir, APP_OUT_NAME)) || APP_OUT_NAME}（删除 ${picked.removed} 项）`);

  if (checkOnly) {
    say(`✔ 诊断结束：本次会输出到 ${picked.dir}`);
    return 0;
  }

  if (!fs.existsSync(BUILDER_CLI)) {
    console.error(`✘ 找不到 electron-builder：${BUILDER_CLI}（先跑一次 pnpm install）`);
    return 1;
  }

  say("▸ 调用 electron-builder");
  const result = spawnSync(
    process.execPath,
    [BUILDER_CLI, ...builderArgs, `--config.directories.output=${picked.dir}`],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(`\n✘ electron-builder 退出码 ${result.status ?? "?"}（见上面的输出）`);
    return result.status ?? 1;
  }

  const exe = path.join(picked.dir, APP_OUT_NAME, "llama-launcher.exe");
  const restored = restoreRuntimeFiles(path.join(picked.dir, APP_OUT_NAME), keptRuntime);
  if (restored.length > 0) say(`  · 已放回：${restored.join("、")}（应用下次启动直接用它，不会重新探测）`);

  if (envFlag("LLAMA_PACKAGE_TOUCH")) {
    const when = new Date();
    const touched = touchTree(path.join(picked.dir, APP_OUT_NAME), when);
    // 顺带把安装包/便携版也刷一遍，免得同一个目录里新旧时间混杂
    for (const name of fs.existsSync(picked.dir) ? fs.readdirSync(picked.dir) : []) {
      if (!name.startsWith(ARTIFACT_PREFIX) || !name.endsWith(".exe")) continue;
      try {
        fs.utimesSync(path.join(picked.dir, name), when, when);
        touched.files += 1;
      } catch {
        touched.failed += 1;
      }
    }
    say(
      `  · 已统一时间戳为 ${when.toLocaleString()}：文件 ${touched.files} 个、目录 ${touched.dirs} 个`
        + (touched.failed > 0 ? `（${touched.failed} 个失败，通常是正被占用）` : ""),
    );
  }

  if (fs.existsSync(exe)) {
    const mb = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
    say(`\n✔ 打包完成：${exe}（${mb} MB）`);
    say("  配置与数据会落在 exe 旁边：llama-launcher.json 与 data/");
  } else {
    say(`\n✔ 打包完成：${picked.dir}（未发现 win-unpacked/llama-launcher.exe，可能是 portable/nsis 目标）`);
  }
  return 0;
}

process.exit(main());
