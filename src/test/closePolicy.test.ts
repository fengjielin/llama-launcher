import assert from "node:assert/strict";
import { test } from "node:test";
import { decideCloseAction } from "../main/closePolicy.ts";

test("关窗决策：服务没跑时点 ✕ 直接退出（默认设置）", () => {
  assert.equal(
    decideCloseAction({ minimizeToTray: false, quitting: false, serverActive: false }),
    "close",
  );
});

test("关窗决策：服务在跑时先问一次，不擅自停服也不擅自缩托盘", () => {
  assert.equal(
    decideCloseAction({ minimizeToTray: false, quitting: false, serverActive: true }),
    "ask",
  );
});

test("关窗决策：显式开了「缩到托盘」就不再问，直接隐藏", () => {
  for (const serverActive of [true, false]) {
    assert.equal(
      decideCloseAction({ minimizeToTray: true, quitting: false, serverActive }),
      "hide-to-tray",
    );
  }
});

test("关窗决策：已在退出流程中一律放行（否则退不掉）", () => {
  for (const minimizeToTray of [true, false]) {
    for (const serverActive of [true, false]) {
      assert.equal(decideCloseAction({ minimizeToTray, quitting: true, serverActive }), "close");
    }
  }
});
