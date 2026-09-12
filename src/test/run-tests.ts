/**
 * 测试入口。
 *
 * 为什么不用 `node --test`：那个运行器会为每个测试文件 spawn 一个子进程并把 stdio 接管道，
 * 在受限沙箱里会直接 EPERM。这里改成在同一个进程里 import 全部测试文件，
 * node:test 会自动执行并设置退出码 —— 不依赖子进程，也不需要任何测试框架。
 *
 * 用法：node src/test/run-tests.ts   （或 pnpm test）
 */

import "./helpProbe.test.ts";
import "./presets.test.ts";
import "./args.test.ts";
import "./config.test.ts";
import "./logLines.test.ts";
import "./health.test.ts";
