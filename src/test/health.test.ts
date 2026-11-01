import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import { baseUrlOf, fetchHealth, findFreePort, probeTcp, waitForTcp } from "../core/health.ts";

function listenPort(server: ReturnType<typeof createServer> | ReturnType<typeof createTcpServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

function closeServer(server: { close(cb: () => void): unknown }): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("baseUrlOf 把 0.0.0.0 换成本机回环", () => {
  assert.equal(baseUrlOf("0.0.0.0", 8080), "http://127.0.0.1:8080");
  assert.equal(baseUrlOf("127.0.0.1", 8080), "http://127.0.0.1:8080");
  assert.equal(baseUrlOf("::", 8001), "http://127.0.0.1:8001");
});

test("probeTcp：监听中为 true，关掉后为 false", async () => {
  const server = createTcpServer();
  const port = await listenPort(server);
  assert.equal(await probeTcp("127.0.0.1", port, 1000), true);
  await closeServer(server);
  assert.equal(await probeTcp("127.0.0.1", port, 500), false);
});

test("/health：200 = ready，503 = loading（服务在、模型还没加载完，不是故障）", async () => {
  let status = 200;
  const server = createServer((_req, res) => {
    res.statusCode = status;
    res.end(status === 200 ? '{"status":"ok"}' : '{"error":{"message":"Loading model"}}');
  });
  const port = await listenPort(server);
  const url = `http://127.0.0.1:${port}`;

  assert.equal((await fetchHealth(url)).state, "ready");

  status = 503;
  const loading = await fetchHealth(url);
  assert.equal(loading.state, "loading");
  assert.equal(loading.httpStatus, 503);

  status = 500;
  assert.equal((await fetchHealth(url)).state, "error");

  await closeServer(server);
  // 服务没了 → 连接被拒，属于"进程还没监听"
  assert.equal((await fetchHealth(url, 500)).state, "unreachable");
});

test("waitForTcp：进程一退出就立刻返回，不干等超时", async () => {
  const started = Date.now();
  const res = await waitForTcp({
    host: "127.0.0.1",
    port: 1,
    timeoutMs: 10_000,
    intervalMs: 100,
    hasExited: () => true,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "exited");
  assert.ok(Date.now() - started < 2000, `不该等满超时，实际 ${Date.now() - started} ms`);
});

test("waitForTcp：端口起来后立刻返回", async () => {
  const server = createTcpServer();
  const port = await listenPort(server);
  const res = await waitForTcp({ host: "127.0.0.1", port, timeoutMs: 3000, intervalMs: 100 });
  assert.equal(res.ok, true);
  assert.ok(res.waitedMs < 3000);
  await closeServer(server);
});

test("waitForTcp：超时返回 timeout", async () => {
  const server = createTcpServer();
  const port = await listenPort(server);
  await closeServer(server);
  const res = await waitForTcp({ host: "127.0.0.1", port, timeoutMs: 600, intervalMs: 100 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "timeout");
});

test("findFreePort：被占用时顺延", async () => {
  const server = createTcpServer();
  const port = await listenPort(server);
  const found = await findFreePort("127.0.0.1", port);
  assert.notEqual(found, port);
  assert.ok(found > port);
  await closeServer(server);

  // 空闲端口原样返回
  assert.equal(await findFreePort("127.0.0.1", found), found);
});
