import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chooseDataLayout, isDirWritable, PORTABLE_DATA_SUBDIR, resolveAppDir } from "../main/paths.ts";

test("isDirWritable：可写目录返回 true，且不留探针文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-paths-"));
  assert.equal(isDirWritable(dir), true);
  // 探针必须被清掉，否则会在用户目录里留下垃圾
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("isDirWritable：不存在的目录返回 false（不抛异常）", () => {
  assert.equal(isDirWritable(join(tmpdir(), "绝对不存在的目录-llama")), false);
});

test("chooseDataLayout：开发模式用项目目录，不动 userData", () => {
  const layout = chooseDataLayout({
    isPackaged: false,
    exeDir: "E:\\app",
    projectDir: "E:\\Code\\llama\\llama-launcher",
    defaultUserDataDir: () => "C:\\Users\\feng\\AppData\\Roaming\\llama-launcher",
  });
  assert.equal(layout.portable, false);
  assert.equal(layout.configPath, join("E:\\Code\\llama\\llama-launcher", "llama-launcher.json"));
  assert.equal(layout.dataDir, "C:\\Users\\feng\\AppData\\Roaming\\llama-launcher");
});

test("chooseDataLayout：打包后 exe 目录可写 → 便携模式（配置与数据都在 exe 旁边）", () => {
  const layout = chooseDataLayout({
    isPackaged: true,
    exeDir: "E:\\llama-launcher-dist\\win-unpacked",
    projectDir: "E:\\Code\\llama\\llama-launcher",
    defaultUserDataDir: () => "C:\\Users\\feng\\AppData\\Roaming\\llama-launcher",
    canWrite: () => true,
  });
  assert.equal(layout.portable, true);
  assert.equal(layout.configPath, join("E:\\llama-launcher-dist\\win-unpacked", "llama-launcher.json"));
  assert.equal(layout.dataDir, join("E:\\llama-launcher-dist\\win-unpacked", PORTABLE_DATA_SUBDIR));
  assert.ok(!layout.configPath.includes("AppData"), "便携模式下不该再用 AppData");
});

test("chooseDataLayout：打包后 exe 目录只读 → 退回 userData（否则连缓存都写不了）", () => {
  const layout = chooseDataLayout({
    isPackaged: true,
    exeDir: "C:\\Program Files\\llama-launcher",
    projectDir: "E:\\Code\\llama\\llama-launcher",
    defaultUserDataDir: () => "C:\\Users\\feng\\AppData\\Roaming\\llama-launcher",
    canWrite: () => false,
  });
  assert.equal(layout.portable, false);
  assert.equal(layout.configPath, join("C:\\Users\\feng\\AppData\\Roaming\\llama-launcher", "llama-launcher.json"));
  assert.equal(layout.dataDir, "C:\\Users\\feng\\AppData\\Roaming\\llama-launcher");
});

test("chooseDataLayout：真实可写目录会被真的探测到（不注入 canWrite）", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-paths-real-"));
  const layout = chooseDataLayout({
    isPackaged: true,
    exeDir: dir,
    projectDir: dir,
    defaultUserDataDir: () => join(dir, "fallback"),
  });
  assert.equal(layout.portable, true);
  assert.equal(layout.configPath, join(dir, "llama-launcher.json"));
  rmSync(dir, { recursive: true, force: true });
});

test("isDirWritable：目录里的文件不影响判定（只探测能否写新文件）", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-paths-files-"));
  writeFileSync(join(dir, "已有文件.txt"), "x", "utf8");
  mkdirSync(join(dir, "子目录"));
  assert.equal(isDirWritable(dir), true);
  rmSync(dir, { recursive: true, force: true });
});

test("resolveAppDir：单文件便携版用 PORTABLE_EXECUTABLE_DIR（不能用 %TEMP% 里的解压目录）", () => {
  // 实测：便携版每次启动都解压到 %TEMP%\<随机名>\，app.getPath("exe") 指的是那里
  const dir = resolveAppDir({
    portableExecutableDir: "E:\\llama-launcher-dist",
    exePath: "C:\\Users\\feng\\AppData\\Local\\Temp\\3JDpNFX2tCZGwr9Q\\llama-launcher.exe",
  });
  assert.equal(dir, "E:\\llama-launcher-dist");
});

test("resolveAppDir：没有该环境变量时用 exe 所在目录（--dir / 安装版 / 开发模式）", () => {
  assert.equal(
    resolveAppDir({ exePath: "E:\\llama-launcher-dist\\win-unpacked\\llama-launcher.exe" }),
    "E:\\llama-launcher-dist\\win-unpacked",
  );
});

test("resolveAppDir：环境变量是空串或纯空白时同样退回 exe 目录", () => {
  const exePath = "E:\\app\\llama-launcher.exe";
  assert.equal(resolveAppDir({ portableExecutableDir: "", exePath }), "E:\\app");
  assert.equal(resolveAppDir({ portableExecutableDir: "   ", exePath }), "E:\\app");
});

test("resolveAppDir：便携目录带尾部分隔符/正斜杠也能归一化", () => {
  assert.equal(
    resolveAppDir({ portableExecutableDir: "E:/llama-launcher-dist/", exePath: "C:\\Temp\\x\\llama-launcher.exe" }),
    "E:\\llama-launcher-dist",
  );
});
