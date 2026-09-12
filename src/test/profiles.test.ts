import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../core/config.ts";
import { deleteProfile, listProfiles, profilePath, readProfile, sanitizeProfileName, saveProfile } from "../core/profiles.ts";
import type { LauncherConfig } from "../core/types.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "llama-profiles-"));
}

test("sanitizeProfileName：去掉 Windows 非法字符与路径分隔符", () => {
  assert.equal(sanitizeProfileName("我的 27B 配置"), "我的 27B 配置");
  assert.equal(sanitizeProfileName("a/b\\c:d*e?f"), "a_b_c_d_e_f");
  assert.equal(sanitizeProfileName('x<y>z|w"v'), "x_y_z_w_v");
  // 控制字符属于"非法字符"的范畴，先被换成下划线；因此制表符/换行会变成 _ 而不是空格
  assert.equal(sanitizeProfileName("带\t制表符\n换行"), "带_制表符_换行");
  // 普通连续空格则会被折叠成一个
  assert.equal(sanitizeProfileName("a  b   c"), "a b c");
});

test("sanitizeProfileName：空名、纯点、纯空白都回退成默认名", () => {
  assert.equal(sanitizeProfileName(""), "默认档案");
  assert.equal(sanitizeProfileName("   "), "默认档案");
  assert.equal(sanitizeProfileName("."), "默认档案");
  assert.equal(sanitizeProfileName(".."), "默认档案");
  assert.equal(sanitizeProfileName("..."), "默认档案");
});

test("sanitizeProfileName：目录穿越输入不会留下路径分隔符", () => {
  for (const evil of ["../../evil", "..\\..\\evil", "a/../../../b", "/etc/passwd"]) {
    const safe = sanitizeProfileName(evil);
    assert.equal(safe.includes("/"), false, `仍含斜杠：${safe}`);
    assert.equal(safe.includes("\\"), false, `仍含反斜杠：${safe}`);
    assert.equal(safe.startsWith("."), false, `仍以点开头：${safe}`);
  }
});

test("sanitizeProfileName：超长名截断到 60 字符", () => {
  const long = "很长的档案名".repeat(30);
  assert.equal(sanitizeProfileName(long).length <= 60, true);
});

test("profilePath：无论名字多离谱，路径都落在给定目录内", () => {
  const dir = tempDir();
  for (const evil of ["../../evil", "..\\..\\evil", "a/b"]) {
    const path = profilePath(dir, evil);
    assert.equal(path.startsWith(dir), true, `逃出了目录：${path}`);
    assert.equal(path.endsWith(".json"), true);
  }
});

test("保存 → 列出 → 读取 的完整往返", () => {
  const dir = tempDir();
  const config: LauncherConfig = {
    ...DEFAULT_CONFIG,
    mode: "router",
    models_dir: "E:\\Code\\llama\\models",
    preload_model: "qwen2.5-7b-instruct-q4_k_m",
    port: 8090,
    context: 16384,
  };

  const saved = saveProfile(dir, "7B 日常", config);
  assert.equal(saved.valid, true);
  assert.equal(saved.name, "7B 日常");
  assert.equal(saved.summary.mode, "router");
  assert.equal(saved.summary.model, "qwen2.5-7b-instruct-q4_k_m");
  assert.equal(saved.summary.port, 8090);
  assert.equal(saved.summary.context, 16384);
  assert.equal(existsSync(saved.path), true);

  const listed = listProfiles(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, "7B 日常");
  assert.equal(listed[0]?.valid, true);

  const loaded = readProfile(saved.path);
  assert.equal(loaded.config.port, 8090);
  assert.equal(loaded.config.preload_model, "qwen2.5-7b-instruct-q4_k_m");
  // 归一化会让 context 原样保留（16384 > 512，不会被当成 K）
  assert.equal(loaded.config.context, 16384);
});

test("single 模式的摘要显示主模型文件名", () => {
  const dir = tempDir();
  const saved = saveProfile(dir, "单模型", {
    ...DEFAULT_CONFIG,
    mode: "single",
    main_model: "E:\\Code\\llama\\models\\Meta-Llama-3-8B-Instruct.Q4_K_M.gguf",
  });
  assert.equal(saved.summary.mode, "single");
  assert.equal(saved.summary.model, "Meta-Llama-3-8B-Instruct.Q4_K_M.gguf");
});

test("listProfiles：目录不存在时返回空数组（首次使用的正常情况）", () => {
  assert.deepEqual(listProfiles(join(tempDir(), "还不存在")), []);
});

test("listProfiles：坏掉的档案单独标记，不影响其它档案", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "坏的.json"), "{ 这不是合法 JSON", "utf8");
  saveProfile(dir, "好的", { ...DEFAULT_CONFIG, port: 8081 });

  const listed = listProfiles(dir);
  assert.equal(listed.length, 2);

  const broken = listed.find((p) => p.name === "坏的");
  assert.ok(broken);
  assert.equal(broken.valid, false);
  assert.equal(broken.summary.model, "（配置无法解析）");

  const good = listed.find((p) => p.name === "好的");
  assert.equal(good?.valid, true);
  assert.equal(good?.summary.port, 8081);
});

test("listProfiles：按最后修改时间从新到旧排序", () => {
  const dir = tempDir();
  const old = saveProfile(dir, "旧的", { ...DEFAULT_CONFIG, port: 8081 });
  const fresh = saveProfile(dir, "新的", { ...DEFAULT_CONFIG, port: 8082 });

  // 明确指定 mtime，避免同一毫秒内写完导致排序不确定
  utimesSync(old.path, new Date(1000), new Date(1000));
  utimesSync(fresh.path, new Date(5000), new Date(5000));

  assert.deepEqual(
    listProfiles(dir).map((p) => p.name),
    ["新的", "旧的"],
  );
});

test("deleteProfile：删掉后列表里不再有它；重复删除不报错", () => {
  const dir = tempDir();
  const saved = saveProfile(dir, "临时", { ...DEFAULT_CONFIG });
  assert.equal(listProfiles(dir).length, 1);

  deleteProfile(dir, "临时");
  assert.equal(existsSync(saved.path), false);
  assert.deepEqual(listProfiles(dir), []);
  // 幂等：再删一次不该抛异常
  deleteProfile(dir, "临时");
});

test("同名保存会覆盖而不是产生两个文件", () => {
  const dir = tempDir();
  saveProfile(dir, "同名", { ...DEFAULT_CONFIG, port: 8081 });
  saveProfile(dir, "同名", { ...DEFAULT_CONFIG, port: 8082 });

  const listed = listProfiles(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.summary.port, 8082);

  // 文件名里的非法字符会被规整，因此 "a/b" 与 "a_b" 视为同一个档案
  saveProfile(dir, "a/b", { ...DEFAULT_CONFIG, port: 8083 });
  saveProfile(dir, "a_b", { ...DEFAULT_CONFIG, port: 8084 });
  assert.equal(listProfiles(dir).filter((p) => p.name === "a_b").length, 1);
});

test("saveProfile：目录不存在会自动创建", () => {
  const dir = join(tempDir(), "深层", "档案");
  assert.equal(existsSync(dir), false);
  const saved = saveProfile(dir, "自动建目录", { ...DEFAULT_CONFIG });
  assert.equal(existsSync(saved.path), true);
  // 写出的文件不带 BOM（与 presets.ini 同样的坑）
  assert.equal(readFileSync(saved.path).subarray(0, 3).toString("hex") === "efbbbf", false);
});

test("readProfile：文件不存在时抛异常（调用方需自行判断存在性）", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "x"), { recursive: true });
  assert.throws(() => readProfile(join(dir, "不存在.json")));
});
