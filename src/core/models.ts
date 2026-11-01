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
 *
 * 另外**过滤掉附属文件**：`mmproj-*.gguf`（视觉投影，要传给 `--mmproj`）和
 * `draft-*.gguf` / `*-draft.gguf`（推测解码的草稿模型，要传给 `--spec-draft-model`）。
 * 它们和主模型放在同一个目录里，但**都不能单独当 `-m`**，混进「主模型」下拉框只会选错；
 * 界面上它们各有专门的路径字段（「视觉投影文件」「草稿模型」）。
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

/** 「看起来像模型、其实不能单独当 `-m` 用」的附属文件类别 */
export type NonModelKind = "mmproj" | "draft";

/** {@link scanModelDir} 的结果 */
export interface ModelScanResult {
  /** 目录是否存在 */
  exists: boolean;
  /** 扫到的模型（附属文件已剔除），按名字排序 */
  models: ScannedModel[];
  /**
   * 被剔除的附属文件数量（视觉投影 / 草稿模型）。
   *
   * 界面拿它解释"为什么目录里有 8 个 .gguf，下拉框只列了 6 个" —— 静默消失会让人
   * 以为文件丢了或扫漏了。
   */
  hidden: Record<NonModelKind, number>;
  /**
   * 约定子目录（`mmproj/`、`draft/`）里的附属文件，供「视觉投影文件」「草稿模型」两个
   * 字段的下拉框用。子目录不存在就是空数组。
   */
  aux: Record<NonModelKind, ScannedModel[]>;
  /** 目录读不了时的原因（界面据此提示"模型目录不可读"） */
  error?: string;
}

/**
 * 判定一个 GGUF 基名是不是附属文件（视觉投影 / 草稿模型）。
 *
 * 依据 llama.cpp 生态的命名约定，**只认独立出现的词**（前面是开头或分隔符、后面也是
 * 分隔符或结尾），这样 `Qwen3-Drafting` 这种把 draft 当普通字母的名字不会被误杀：
 * - mmproj：`mmproj-Qwen3-F16.gguf`、`Qwen2.5-VL-7B-mmproj-F16.gguf`
 * - draft：`draft-Qwen3-0.6B.gguf`、`Qwen3-0.6B-draft.gguf`
 *
 * @param stem 文件名去掉 `.gguf`（分片则是去掉分片后缀后的基名）
 * @returns 附属文件类别；是主模型则为 `null`
 */
export function nonModelKindOf(stem: string): NonModelKind | null {
  if (/(^|[-_.])mmproj([-_.]|$)/i.test(stem)) return "mmproj";
  if (/(^|[-_.])draft([-_.]|$)/i.test(stem)) return "draft";
  return null;
}

/** llama.cpp 分片文件名：`<base>-00001-of-00003.gguf` */
const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})$/i;

/**
 * 约定子目录名：视觉投影放 `<models_dir>/mmproj/`，草稿模型放 `<models_dir>/draft/`。
 *
 * 有了目录约定，文件名就随便叫（`Qwen3-0.6B-Q8_0.gguf` 也能被认成草稿模型），
 * 不依赖命名里带 `mmproj` / `draft` 这两个词。
 */
export const AUX_SUBDIRS: Record<NonModelKind, string> = { mmproj: "mmproj", draft: "draft" };

/** 一个 GGUF 文件在分片组里的位置信息 */
interface ShardEntry {
  path: string;
  index: number;
  sizeMiB: number | null;
  declared: number | null;
}

/**
 * 读一个目录**顶层**的 .gguf，按基名把分片归组。
 *
 * @param dir 目录
 * @returns 基名 → 分片列表；目录读不了时 `groups` 为空并带 `error`
 */
function collectShardGroups(dir: string): { groups: Map<string, ShardEntry[]>; error?: string } {
  const groups = new Map<string, ShardEntry[]>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    return { groups, error: `目录读不了：${err instanceof Error ? err.message : String(err)}` };
  }

  for (const entry of names) {
    if (!entry.toLowerCase().endsWith(".gguf")) continue;
    const full = join(dir, entry);
    let sizeMiB: number | null = null;
    try {
      const st = statSync(full);
      if (!st.isFile()) continue; // 同名目录（含约定子目录本身）跳过
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
  return { groups };
}

/**
 * 把分片分组结果合成模型条目（分片乱序读进来是常态，按编号排序后取第一个作为 `-m` 的参数）。
 *
 * @param groups {@link collectShardGroups} 的结果
 * @returns 按名字排序的模型列表
 */
function groupsToModels(groups: Map<string, ShardEntry[]>): ScannedModel[] {
  const models: ScannedModel[] = [];
  for (const [name, shards] of groups) {
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
  return models;
}

/**
 * 扫一个模型目录，返回可直接用于下拉框的模型列表。
 *
 * 行为：
 * - 只认 `.gguf`（大小写不敏感），忽略其它文件与子目录
 * - 分片按基名合并成一条，路径取**编号最小的那个分片**，体积相加
 * - 顶层里名字带 `mmproj` / `draft` 的附属文件剔除（记账到 `hidden`）
 * - 约定子目录 `mmproj/`、`draft/` 单独扫，结果放进 `aux`（给两个附属字段的下拉框）
 * - 目录不存在 / 读不了都**不抛异常**，而是返回空列表 + `error`，界面照常渲染
 *
 * @param dir 模型目录（配置里的 `models_dir`）
 * @returns 见 {@link ModelScanResult}
 */
export function scanModelDir(dir: string): ModelScanResult {
  const emptyHidden = (): Record<NonModelKind, number> => ({ mmproj: 0, draft: 0 });
  const emptyAux = (): Record<NonModelKind, ScannedModel[]> => ({ mmproj: [], draft: [] });

  const trimmed = dir.trim();
  if (trimmed === "") {
    return { exists: false, models: [], hidden: emptyHidden(), aux: emptyAux(), error: "模型目录为空" };
  }
  if (!existsSync(trimmed)) {
    return { exists: false, models: [], hidden: emptyHidden(), aux: emptyAux(), error: `目录不存在：${trimmed}` };
  }

  const top = collectShardGroups(trimmed);
  if (top.error !== undefined) {
    return { exists: true, models: [], hidden: emptyHidden(), aux: emptyAux(), error: top.error };
  }

  // 顶层：视觉投影 / 草稿模型不能单独当 -m，剔掉但记账（界面据此说明"少了几个"）
  const hidden = emptyHidden();
  const models: ScannedModel[] = [];
  for (const model of groupsToModels(top.groups)) {
    const kind = nonModelKindOf(model.name);
    if (kind !== null) {
      hidden[kind] += 1;
      continue;
    }
    models.push(model);
  }

  // 约定子目录：附属文件按用途各放一处，文件名怎么起都能认出来
  const aux = emptyAux();
  for (const kind of ["mmproj", "draft"] as const) {
    const sub = join(trimmed, AUX_SUBDIRS[kind]);
    if (!existsSync(sub)) continue; // 没建这个子目录就是没有
    aux[kind] = groupsToModels(collectShardGroups(sub).groups);
  }

  return { exists: true, models, hidden, aux };
}
