import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanModelDir } from "../core/models.ts";

/**
 * 造一个指定大小的文件（只需大小有意义，内容随便）。
 *
 * @param path 目标路径
 * @param mib 大小（MiB）
 * @returns 该路径
 */
function makeFile(path: string, mib: number): string {
  writeFileSync(path, Buffer.alloc(Math.max(1, Math.round(mib * 1024 * 1024))));
  return path;
}

test("扫模型目录：列出 .gguf、忽略其它文件与子目录，按名字排序", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-models-"));
  try {
    makeFile(join(dir, "b-model.gguf"), 1);
    makeFile(join(dir, "a-model.gguf"), 1);
    makeFile(join(dir, "readme.txt"), 1);
    makeFile(join(dir, "notes.GGUF"), 1); // 大小写不敏感也要认
    mkdirSync(join(dir, "sub.gguf")); // 同名目录要跳过

    const r = scanModelDir(dir);
    assert.equal(r.exists, true);
    assert.deepEqual(
      r.models.map((m) => m.name),
      ["a-model", "b-model", "notes"],
    );
    assert.equal(r.models[0]?.shardCount, 1);
    assert.equal(r.models[0]?.path, join(dir, "a-model.gguf"));
    assert.ok((r.models[0]?.sizeMiB ?? 0) >= 1, "应读到体积");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫模型目录：分片合并成一条，-m 用第一个分片，体积相加", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-models-shard-"));
  try {
    makeFile(join(dir, "big-00003-of-00003.gguf"), 1);
    makeFile(join(dir, "big-00001-of-00003.gguf"), 1);
    makeFile(join(dir, "big-00002-of-00003.gguf"), 1);

    const r = scanModelDir(dir);
    assert.equal(r.models.length, 1, "三个分片应合成一个模型");
    const model = r.models[0]!;
    assert.equal(model.name, "big", "名字去掉分片后缀");
    assert.equal(model.shardCount, 3);
    assert.equal(model.path, join(dir, "big-00001-of-00003.gguf"), "按编号排序取第一个分片");
    assert.equal(model.sizeMiB, 3, "各分片体积相加");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫模型目录：分片名只有一个文件时按基名列出，并记下声明的分片数（能看出下载不全）", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-models-weird-"));
  try {
    makeFile(join(dir, "m-00001-of-00003.gguf"), 1);
    makeFile(join(dir, "n-00002.gguf"), 1); // 缺 -of-NNNNN，不是合法分片名

    const r = scanModelDir(dir);
    const byName = new Map(r.models.map((m) => [m.name, m]));
    assert.deepEqual([...byName.keys()].sort(), ["m", "n-00002"]);

    const m = byName.get("m")!;
    assert.equal(m.shardCount, 1, "目录里只找到 1 个分片");
    assert.equal(m.declaredShards, 3, "文件名声明是 3 个 → 界面可以提示分片不全");
    assert.equal(m.path, join(dir, "m-00001-of-00003.gguf"));
    assert.equal(byName.get("n-00002")!.declaredShards, null, "不合规的名字不当作分片");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫模型目录：目录不存在 / 空串 / 不可读时都不抛异常", () => {
  const missing = scanModelDir(join(tmpdir(), "绝对不存在的模型目录-llama"));
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.models, []);
  assert.ok((missing.error ?? "").includes("不存在"), missing.error);

  const empty = scanModelDir("   ");
  assert.equal(empty.exists, false);
  assert.ok((empty.error ?? "").includes("空"), empty.error);
});

test("扫模型目录：空目录返回空列表且 exists 为真", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-models-empty-"));
  try {
    const r = scanModelDir(dir);
    assert.equal(r.exists, true);
    assert.deepEqual(r.models, []);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.hidden, { mmproj: 0, draft: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫模型目录：剔除视觉投影与草稿模型，并记账（下拉框只列能当 -m 的）", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-models-filter-"));
  try {
    makeFile(join(dir, "main-model.gguf"), 1);
    makeFile(join(dir, "mmproj-main-model-F16.gguf"), 1);
    makeFile(join(dir, "draft-Qwen3-0.6B.gguf"), 1);
    makeFile(join(dir, "Qwen3-8B-draft.gguf"), 1);
    // 附属文件也可能分片：合并后按基名一起判掉
    makeFile(join(dir, "mmproj-side-00001-of-00002.gguf"), 1);
    makeFile(join(dir, "mmproj-side-00002-of-00002.gguf"), 1);

    const r = scanModelDir(dir);
    assert.deepEqual(r.models.map((m) => m.name), ["main-model"], "只留下主模型");
    assert.deepEqual(r.hidden, { mmproj: 2, draft: 2 }, "剔除数量要如实记账，界面据此说明");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫模型目录：名字里只是碰巧含 draft 的普通模型不误杀", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-models-draftish-"));
  try {
    makeFile(join(dir, "Qwen3-Drafting.gguf"), 1);
    makeFile(join(dir, "redraft-8b.gguf"), 1);

    const r = scanModelDir(dir);
    assert.deepEqual(
      r.models.map((m) => m.name).sort(),
      ["Qwen3-Drafting", "redraft-8b"],
      "只认独立出现的 draft 词，不做子串匹配",
    );
    assert.deepEqual(r.hidden, { mmproj: 0, draft: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫模型目录：目录里只有附属文件时 models 为空，但 hidden 有值（界面能解释空下拉框）", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-models-only-aux-"));
  try {
    makeFile(join(dir, "mmproj-model-F16.gguf"), 1);

    const r = scanModelDir(dir);
    assert.equal(r.exists, true);
    assert.deepEqual(r.models, []);
    assert.deepEqual(r.hidden, { mmproj: 1, draft: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫模型目录：约定子目录 mmproj/ 与 draft/ 里的文件进 aux，不混进主模型（名字随便起）", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-models-auxdirs-"));
  try {
    makeFile(join(dir, "main.gguf"), 1);
    mkdirSync(join(dir, "mmproj"));
    mkdirSync(join(dir, "draft"));
    // 故意不用 mmproj / draft 命名：目录约定本身就该认得出来
    makeFile(join(dir, "mmproj", "随便起名-F16.gguf"), 1);
    makeFile(join(dir, "draft", "Qwen3-0.6B-Q8_0.gguf"), 1);
    makeFile(join(dir, "draft", "小模型-00001-of-00002.gguf"), 1);
    makeFile(join(dir, "draft", "小模型-00002-of-00002.gguf"), 1);

    const r = scanModelDir(dir);
    assert.deepEqual(r.models.map((m) => m.name), ["main"], "主模型列表只留顶层主模型");
    assert.deepEqual(r.aux.mmproj.map((m) => m.name), ["随便起名-F16"]);
    const draftNames = r.aux.draft.map((m) => m.name);
    assert.equal(draftNames.length, 2, "子目录里同样按分片合并成一条");
    assert.ok(draftNames.includes("Qwen3-0.6B-Q8_0"));
    assert.ok(draftNames.includes("小模型"));
    assert.deepEqual(r.hidden, { mmproj: 0, draft: 0 }, "进候选的不算「隐藏」，别重复记账");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫模型目录：没有约定子目录时 aux 是空数组，不影响主列表", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-models-noaux-"));
  try {
    makeFile(join(dir, "only.gguf"), 1);

    const r = scanModelDir(dir);
    assert.deepEqual(r.aux, { mmproj: [], draft: [] });
    assert.deepEqual(r.models.map((m) => m.name), ["only"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
