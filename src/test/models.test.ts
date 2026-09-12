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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
