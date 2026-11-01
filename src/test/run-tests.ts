/**
 * 测试入口。
 *
 * 为什么不用 `node --test`：那个运行器会为每个测试文件 spawn 一个子进程并把 stdio 接管道，
 * 在受限沙箱里会直接 EPERM。这里改成在同一个进程里 import 全部测试文件，
 * node:test 会自动执行并设置退出码 —— 不依赖子进程，也不需要任何测试框架。
 *
 * 用法：node src/test/run-tests.ts   （或 pnpm test）
 */

// ---- M1：core 层 ----
import "./helpProbe.test.ts";
import "./presets.test.ts";
import "./args.test.ts";
import "./config.test.ts";
import "./logLines.test.ts";
import "./health.test.ts";

// ---- M3：指标采集与档案管理 ----
import "./gpu.test.ts";
import "./sysinfo.test.ts";
import "./metrics.test.ts";
import "./profiles.test.ts";

// ---- M4：环境自检 ----
import "./pe.test.ts";
import "./precheck.test.ts";
import "./paths.test.ts";

// ---- 首次运行、自动探测与数据落点 ----
import "./discover.test.ts";
import "./modelLayout.test.ts";

// ---- 关窗行为（智能 ✕ 的决策表）----
import "./closePolicy.test.ts";

// ---- 纯格式化（渲染层也用的叶子模块）----
import "./format.test.ts";

// ---- 模型目录扫描（单模型模式的下拉框）----
import "./models.test.ts";

// ---- 预设 → 配置填充（单模型复用 presets 的口径）----
import "./presetApply.test.ts";
