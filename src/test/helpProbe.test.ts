import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createCapabilities,
  createCapabilitiesWithout,
  parseHelp,
  readBuildNumber,
} from "../core/helpProbe.ts";

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures");
const help = readFileSync(join(fixturesDir, "help-b10488.txt"), "utf8");
const version = readFileSync(join(fixturesDir, "version-b10488.txt"), "utf8");

test("版本号解析：b10488", () => {
  assert.equal(readBuildNumber(version), 10488);
  assert.equal(readBuildNumber("version: dev (build 10679, commit abc)"), 10679);
  assert.equal(readBuildNumber("build b10679 dev"), 10679);
  assert.equal(readBuildNumber("nothing here"), null);
});

test("选项与分节解析：数量与分节名都对得上", () => {
  const model = parseHelp(help);
  assert.ok(model.options.length > 200, `解析到的选项太少：${model.options.length}`);
  assert.ok(model.sections.includes("common params"), `分节：${model.sections.join(",")}`);
  assert.ok(model.sections.includes("sampling params"));
  assert.ok(model.sections.includes("speculative params"));
});

test("逗号别名列表 + 对齐填充：-n / -m 全别名都要认", () => {
  const model = parseHelp(help);

  const predict = model.byFlag.get("-n");
  assert.ok(predict, "应能解析 -n");
  assert.deepEqual(predict.flags, ["-n", "--predict", "--n-predict"]);
  assert.equal(predict.valuePlaceholder, "N");
  assert.equal(predict.default, "-1");
  assert.equal(predict.primary, "--predict");
  assert.equal(model.byFlag.get("--n-predict"), predict, "别名应指向同一条选项");

  const modelPath = model.byFlag.get("-m");
  assert.ok(modelPath, "应能解析 -m");
  assert.deepEqual(modelPath.flags, ["-m", "--model"]);
  assert.equal(modelPath.valuePlaceholder, "FNAME");
});

test("缩进的项目符号不会被误判成选项", () => {
  const model = parseHelp(help);
  assert.equal(model.byFlag.has("- row"), false);
  assert.equal(model.byFlag.has("--split-mode"), true, "--split-mode 的真选项仍要认出来");
  for (const option of model.options) {
    for (const flag of option.flags) {
      assert.ok(flag.startsWith("-") && flag.length > 1, `非法参数名：${flag}`);
    }
  }
});

test("值占位符与描述的切分（含占位符本身就是枚举表的情况）", () => {
  const model = parseHelp(help);

  const fa = model.byFlag.get("-fa");
  assert.ok(fa);
  assert.equal(fa.valuePlaceholder, "[on|off|auto]");
  assert.ok(fa.description.startsWith("set Flash Attention use"), fa.description);

  // `--spec-type none,draft-simple,...`：占位符是逗号枚举表，而且没有描述
  const specType = model.byFlag.get("--spec-type");
  assert.ok(specType);
  assert.ok(specType.valuePlaceholder.includes("draft-dflash"), specType.valuePlaceholder);

  // 纯开关：占位符为空
  const mlock = model.byFlag.get("--mlock");
  assert.ok(mlock);
  assert.equal(mlock.valuePlaceholder, "");
  assert.equal(mlock.deprecated, true, "--mlock 在 b10488 里已标 DEPRECATED");
});

test("env 与 default 抽取", () => {
  const model = parseHelp(help);
  const ctx = model.byFlag.get("-c");
  assert.ok(ctx);
  assert.equal(ctx.env, "LLAMA_ARG_CTX_SIZE");
  assert.equal(ctx.default, "0");
});

test("能力视图：按优先级回退 / 取值形式 / 枚举解析", () => {
  const caps = createCapabilities(help);

  // 旧名不存在 → 回退命中新名（参数漂移的核心机制）
  assert.equal(caps.pick(["--draft-type-k", "--spec-draft-type-k"]), "--spec-draft-type-k");
  assert.equal(caps.pick(["--does-not-exist", "--fit-target"]), "--fit-target");
  assert.equal(caps.pick(["--nope-a", "--nope-b"]), null);

  assert.equal(caps.hasValue("-fa"), true);
  assert.equal(caps.hasValue("--mlock"), false);
  assert.deepEqual(caps.enumValues("-fa"), ["on", "off", "auto"]);
  assert.ok(caps.enumValues("--spec-type")?.includes("draft-mtp"));
  assert.equal(caps.enumValues("--mlock"), null);

  // schema 里用到的这些名字都必须真实存在（曾经因为 help 的对齐空格误判过）
  for (const flag of [
    "-m",
    "--model",
    "--models-dir",
    "--models-preset",
    "--models-max",
    "--temp",
    "--top-p",
    "--top-k",
    "--min-p",
    "--presence-penalty",
    "--repeat-penalty",
    "--cache-type-k",
    "--cache-type-v",
    "--fit-target",
    "--load-mode",
    "--reasoning",
    "--reasoning-effort",
    "--reasoning-budget",
    "--reasoning-format",
    "--chat-template-kwargs",
    "--spec-draft-model",
    "--spec-draft-n-max",
    "--spec-draft-type-k",
    "--spec-type",
    "--no-webui",
    "--no-mmap",
    "--no-warmup",
    "--tools",
    "--agent",
    "--jinja",
    "--api-key",
    "--log-file",
    "--metrics",
    "-ngl",
    "-np",
    "-mm",
  ]) {
    assert.equal(caps.has(flag), true, `${flag} 应当存在于 b10488 的 --help 中`);
  }
});

test("createCapabilitiesWithout 用来模拟旧版本", () => {
  const caps = createCapabilitiesWithout(help, ["--fit-target", "-fitt"]);
  assert.equal(caps.has("--fit-target"), false);
  assert.equal(caps.pick(["--fit-target", "-fitt"]), null);
  assert.equal(caps.has("-ngl"), true, "其它参数不受影响");
  assert.equal(caps.option("--fit-target"), undefined);
});
