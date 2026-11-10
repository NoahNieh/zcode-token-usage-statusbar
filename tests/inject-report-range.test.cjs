"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

/* 夹具路径按平台取真实形态：Windows 的 fileURLToPath 要求盘符，
 * 用 POSIX 假路径会让 pollPluginRequests 的本地页门控整体抛错（既有 git 夹具同款限制）。 */
const WIN = process.platform === "win32";
const RES = WIN ? "C:\\fixture\\resources" : "/fixture/resources";
const RT = WIN ? "C:\\fixture\\runtime" : "/fixture/runtime";
const WIN_URL = WIN ? "file:///C:/fixture/resources/index.html" : "file:///fixture/resources/index.html";

/* v265 ⚙ 用量报表「自选范围」主进程动作：整文件 vm 加载（同 inject-git-status 夹具），
 * execFile 按 argv 回放。覆盖日期/跨度校验、合法请求的 argv 与回执、Python error/
 * 非 JSON/回显不匹配的降级。 */

function loadPump(respond = () => ({})) {
  const intervals = [], windows = [], execs = [];
  let id = 0;
  const mockFs = {
    readFileSync: file => String(file).endsWith("config.json") ? "{}" : "",
    statSync: file => {
      if ([path.join(RT, "overlay.js"), path.join(RT, "zusage.py")].includes(file)) return { mtimeMs: 1, size: 1 };
      throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" });
    },
    readdirSync: () => [],
    existsSync: () => false,
    watch: () => ({ on() {} }),
    writeFileSync() {},
  };
  const ipc = new EventEmitter();
  const sandbox = {
    __dirname: RT, console: { error() {} },
    process: { resourcesPath: RES, execPath: process.execPath, uptime: () => 1, env: {} },
    module: { exports: {} },
    setTimeout: (fn, ms) => { id++; return id; },
    clearTimeout() {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval() {},
    require(name) {
      if (name === "fs") return mockFs;
      if (["path", "url", "crypto"].includes(name)) return require(name);
      if (name === "electron") return {
        app: { getPath: () => "/fixture/home", on() {} },
        webContents: { getAllWebContents: () => windows },
        ipcMain: ipc,
      };
      if (name === "child_process") return {
        spawn() {
          const p = new EventEmitter();
          p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
          p.stdin = new EventEmitter(); p.stdin.writable = true; p.kill = () => { };
          return p;
        },
        execFile(cmd, args, opts, cb) {
          execs.push({ cmd, args, opts });
          let r = {};
          try { r = respond(args) || {}; } catch (e) { r = { error: e }; }
          cb(r.error || null, r.stdout || "", r.stderr || "");
        },
      };
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  function addWindow(url = WIN_URL) {
    const wc = {
      id: windows.length + 1, requests: [], pushes: [],
      getType: () => "window", isDestroyed: () => false, getURL: () => url,
      executeJavaScript: async js => {
        if (js.includes("__zusagePluginRequests")) return wc.requests.splice(0, 8);
        if (js.startsWith("window.")) { wc.pushes.push(js); return true; }
        return "null";
      },
    };
    windows.push(wc);
    return wc;
  }
  return { api: sandbox.module.exports.__zusageTest, intervals, execs, addWindow };
}

function resultOf(wc) {
  const js = wc.pushes.filter(s => s.startsWith("window.__zusagePluginResult")).pop();
  assert.ok(js, "result pushed");
  const m = js.match(/__zusagePluginResult\((\{.*\})\)$/);
  assert.ok(m, "result payload parsed");
  return JSON.parse(m[1]);
}

const RANGE = {
  models: [{ model: "GLM-5.3", provider: "account:test", requests: 2, input: 20,
    output: 300, total: 320, cache_read: 10, tps: 50 }],
  totals: { requests: 2, input: 20, output: 300, total: 320, cache_read: 10,
    cache_write: 0, reasoning: 0, rated_output: 300, unrated_output: 0, gen_ms: 6000,
    tps: 50, started: 1, last_at: 2 },
  days: [{ d: "10-01 Wed", date: "2026-10-01", requests: 2, input: 20, output: 300, total: 320 }],
};
const respondEcho = args => args[1] === "report-range"
  ? { stdout: JSON.stringify(Object.assign({}, RANGE, { from: args[2], to: args[3] })) }
  : {};

test("valid range spawns zusage report-range and echoes a structured result", async () => {
  const h = loadPump(respondEcho);
  const wc = h.addWindow();
  wc.requests.push({ action: "report-range", from: "2026-10-01", to: "2026-10-31", requestId: "r1" });
  await h.api.pollPluginRequests();
  await flush();
  assert.equal(h.execs.length, 1);
  assert.deepEqual(Array.from(h.execs[0].args), [path.join(RT, "zusage.py"), "report-range", "2026-10-01", "2026-10-31"]);
  assert.equal(h.execs[0].opts.timeout, 15000);
  assert.equal(h.execs[0].opts.windowsHide, true);
  const r = resultOf(wc);
  assert.equal(r.id, "r1");
  assert.equal(r.ok, true);
  assert.equal(r.from, "2026-10-01");
  assert.equal(r.to, "2026-10-31");
  assert.equal(r.totals.total, 320);
  assert.equal(r.models[0].model, "GLM-5.3");
  assert.equal(r.days[0].date, "2026-10-01");
});

test("invalid dates/order/span are rejected before spawning", async () => {
  const h = loadPump(respondEcho);
  const wc = h.addWindow();
  const bad = [
    ["2026-1-1", "2026-10-31"],
    ["2026-02-30", "2026-03-01"],
    ["2026-10-31", "2026-10-01"],
    ["2024-01-01", "2025-01-01"],
    ["", "2026-10-01"],
  ];
  bad.forEach((pair, i) => wc.requests.push({
    action: "report-range", from: pair[0], to: pair[1], requestId: "bad" + i,
  }));
  await h.api.pollPluginRequests();
  await flush();
  assert.equal(h.execs.length, 0, "no python spawn for invalid ranges");
  const results = wc.pushes.filter(s => s.startsWith("window.__zusagePluginResult")).map(s => {
    const m = s.match(/__zusagePluginResult\((\{.*\})\)$/);
    return JSON.parse(m[1]);
  });
  assert.equal(results.length, bad.length);
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid-range");
  }
});

test("python error JSON, non-JSON stdout and mismatched echo degrade to query-failed", async () => {
  const cases = [
    () => ({ stdout: JSON.stringify({ error: "query failed" }) }),
    () => ({ stdout: "Usage: zusage.py ..." }),
    () => ({ stdout: JSON.stringify(Object.assign({}, RANGE, { from: "1999-01-01", to: "1999-01-02" })) }),
  ];
  for (const respond of cases) {
    const h = loadPump(respond);
    const wc = h.addWindow();
    wc.requests.push({ action: "report-range", from: "2026-10-01", to: "2026-10-31", requestId: "x" });
    await h.api.pollPluginRequests();
    await flush();
    assert.equal(h.execs.length, 1);
    const r = resultOf(wc);
    assert.equal(r.ok, false);
    assert.equal(r.error, "query-failed");
  }
});

test("validReportRange mirrors the python bounds (366 days inclusive)", () => {
  const { api } = loadPump();
  assert.equal(api.validReportRange("2024-02-29", "2024-03-01"), true);
  assert.equal(api.validReportRange("2024-01-01", "2024-12-31"), true);   // 366 天
  assert.equal(api.validReportRange("2024-01-01", "2025-01-01"), false);  // 367 天
  assert.equal(api.validReportRange("2026-10-01", "2026-09-30"), false);
  assert.equal(api.validReportRange("2026-1-1", "2026-01-02"), false);
  assert.equal(api.validReportRange("2026-02-30", "2026-03-01"), false);
});
