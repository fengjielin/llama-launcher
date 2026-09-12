/**
 * 扫模型目录：给界面上的"从模型目录选择"下拉框提供数据。
 *
 * 单独成模块的原因：**判断哪几个文件其实是同一个模型（分片）**是有规则的活，
 * 放在渲染层就没法单测了。规则来自 llama.cpp 自己的分片命名（`--split`）：
 *   `名字-00001-of-00003.gguf`、`名字-00002-of-00003.gguf` …
 * 其中**只有第一个分片**要传给 `-m`（llama.cpp 会顺着它把其余分片读进来），
 * 所以这里把它们合成一条，避免下拉框里出现三行看起来像三个模型的东西。
 *
 * 只扫目录**顶层**（不递归）：模型目录的常见用法就是平铺放 .gguf；
 * 放在别处的模型走「浏览…」手动选，别让下拉框里出现一堆跨目录的同名项。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 扫到的一个模型（分片已合并成一条） */
export interface ScannedModel {
  /** 模型名 = GGUF 文件名去掉 `.gguf`（分片则是去掉 `-00001-of-00003` 之后的基名） */
  name: string;
  /** 单模型模式下要传给 `-m` 的路径（分片模型是**第一个分片**） */
  path: string;
  /** 体积，MiB（分片模型为各分片之和；读不到大小时为 `null`） */
  sizeMiB: number | null;
  /** 分片数（目录里实际找到几个）；`1` 表示不分片 */
  shardCount: number;
  /**
   * 文件名里**声明的**分片总数（`-00001-of-00003` 里的 3）；非分片为 `null`。
   *
   * 与 {@link ScannedModel.shardCount} 不等就说明分片不全（下载没完成），
   * 界面据此提示 —— 否则用户只会看到 llama.cpp 一句难懂的加载失败。
   */
  declaredShards: number | null;
}

/** {@link scanModelDir} 的结果 */
export interface ModelScanResult {
  /** 目录是否存在 */
  exists: boolean;
  /** 扫到的模型，按名字排序 */
  models: ScannedModel[];
  /** 目录读不了时的原因（界面据此提示"模型目录不可读"） */
  error?: string;
}

/** llama.cpp 分片文件名：`<base>-00001-of-00003.gguf` */
const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})$/i;

/**
 * 扫一个模型目录，返回可直接用于下拉框的模型列表。
 *
 * 行为：
 * - 只认 `.gguf`（大小写不敏感），忽略其它文件与子目录
 * - 分片按基名合并成一条，路径取**编号最小的那个分片**，体积相加
 * - 目录不存在 / 读不了都**不抛异常**，而是返回空列表 + `error`，界面照常渲染
 *
 * @param dir 模型目录（配置里的 `models_dir`）
 * @returns 见 {@link ModelScanResult}
 */
export function scanModelDir(dir: string): ModelScanResult {
  const trimmed = dir.trim();
  if (trimmed === "") return { exists: false, models: [], error: "模型目录为空" };
  if (!existsSync(trimmed)) return { exists: false, models: [], error: `目录不存在：${trimmed}` };

  let names: string[];
  try {
    names = readdirSync(trimmed);
  } catch (err) {
    return { exists: true, models: [], error: `目录读不了：${err instanceof Error ? err.message : String(err)}` };
  }

  /** 基名 → 该模型的所有分片（或单个文件） */
  const groups = new Map<string, { path: string; index: number; sizeMiB: number | null; declared: number | null }[]>();
  for (const entry of names) {
    if (!entry.toLowerCase().endsWith(".gguf")) continue;
    const full = join(trimmed, entry);
    let sizeMiB: number | null = null;
    try {
      const st = statSync(full);
      if (!st.isFile()) continue; // 同名目录之类，跳过
      sizeMiB = Math.round(st.size / (1024 * 1024));
    } catch {
      continue; // 读不到就跳过这一项，不影响其它模型
    }

    const stem = entry.slice(0, -".gguf".length);
    const shard = SHARD_RE.exec(stem);
    const base = shard?.[1] ?? stem;
    const index = shard === null ? 1 : Number(shard[2]);
    const list = groups.get(base) ?? [];
    list.push({ path: full, index, sizeMiB, declared: shard === null ? null : Number(shard[3]) });
    groups.set(base, list);
  }

  const models: ScannedModel[] = [];
  for (const [name, shards] of groups) {
    // 分片乱序读进来是常态，按编号排序后取第一个作为 -m 的参数
    const sorted = [...shards].sort((a, b) => a.index - b.index);
    const sizes = sorted.map((s) => s.sizeMiB);
    // 全部读不到大小就给 null（界面显示"体积未知"）；否则缺失的那些按 0 计
    const totalMiB = sizes.every((s) => s === null) ? null : sizes.reduce<number>((sum, s) => sum + (s ?? 0), 0);
    models.push({
      name,
      path: sorted[0]!.path,
      sizeMiB: totalMiB,
      shardCount: sorted.length,
      declaredShards: sorted[0]!.declared,
    });
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return { exists: true, models };
}
