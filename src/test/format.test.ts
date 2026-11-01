import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToMiB, formatMiB, summarizeDetect } from "../core/format.ts";

test("formatMiB：MiB / GB 分界与不可用字段", () => {
  assert.equal(formatMiB(15103), "14.7 GB");
  assert.equal(formatMiB(512), "512 MiB");
  assert.equal(formatMiB(1024), "1.0 GB");
  assert.equal(formatMiB(16380), "16.0 GB");
  assert.equal(formatMiB(0), "0 MiB");
  assert.equal(formatMiB(null), "N/A");
});

test("bytesToMiB：四舍五入", () => {
  assert.equal(bytesToMiB(1024 * 1024), 1);
  assert.equal(bytesToMiB(1024 * 1024 * 1.4), 1);
  assert.equal(bytesToMiB(1024 * 1024 * 1.6), 2);
});

test("summarizeDetect：成功时给出版本、参数数与各项计数", () => {
  const text = summarizeDetect({
    ok: true,
    build: 10488,
    optionCount: 248,
    renamed: 0,
    unsupported: 0,
    deprecated: 2,
    elapsedMs: 367,
  });
  assert.equal(text, "重新探测完成：b10488 · 248 个参数 · 改名 0 / 不支持 0 / 废弃 2 · 用时 0.4s");
});

test("summarizeDetect：版本解析不出来时不谎报版本号", () => {
  const text = summarizeDetect({
    ok: true,
    build: null,
    optionCount: 0,
    renamed: 0,
    unsupported: 0,
    deprecated: 0,
    elapsedMs: 1200,
  });
  assert.ok(text.includes("版本未知"), text);
  assert.ok(text.includes("1.2s"), text);
});

test("summarizeDetect：探测失败时必须说成失败，不能看着像成功", () => {
  const text = summarizeDetect({
    ok: false,
    build: null,
    optionCount: 0,
    renamed: 0,
    unsupported: 0,
    deprecated: 0,
    failure: "--help 超时",
    elapsedMs: 9000,
  });
  assert.ok(text.includes("未完成"), text);
  assert.ok(text.includes("--help 超时"), text);
  assert.equal(text.startsWith("重新探测完成："), false, "失败时不能用『重新探测完成：』这种像成功的开头");
});

test("summarizeDetect：失败但没给原因时也有兜底文案", () => {
  const text = summarizeDetect({
    ok: false,
    build: null,
    optionCount: 0,
    renamed: 0,
    unsupported: 0,
    deprecated: 0,
    elapsedMs: 500,
  });
  assert.ok(text.includes("没能解析出参数表"), text);
});
