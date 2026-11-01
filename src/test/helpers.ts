/**
 * 测试公用夹具。
 *
 * 只放"多个测试文件都要做、且做错会互相影响"的动作：临时目录与假的 llama.cpp 目录。
 * 断言仍留在各自的 test 里 —— 这样看一个测试文件就能知道它守的是什么。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 在系统临时目录里执行一段同步逻辑，结束后递归删除。
 *
 * 之前每个用例都手写 `mkdtempSync` + `try/finally rmSync`，37 处样板里漏清理过；
 * 收敛到这里后，新增用例不必再记得 finally。
 *
 * @param prefix 临时目录前缀（便于排查是谁留下的）
 * @param fn 测试主体，参数是创建出来的目录
 * @returns `fn` 的返回值
 */
export function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 造一个假的 llama.cpp 目录：目录探测只认 `llama-server.exe` 是否存在。
 *
 * 需要真实文件的场景（PE 导入表、模型头）不要用这个，另造对应文件。
 *
 * @param dir 目标目录
 * @returns 该目录的绝对路径
 */
export function makeLlamaDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.exe"), "", "utf8");
  return resolve(dir);
}
