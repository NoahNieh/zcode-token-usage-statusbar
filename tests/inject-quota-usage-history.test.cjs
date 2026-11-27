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
 * 用 POSIX 假路径会让 pollPluginRequests 的本地页门控整体抛错（inject-report-range 同款限制）。 */
const WIN = process.platform === "win32";
const RES = WIN ? "C:\\fixture\\resources" : "/fixture/resources";
const RT = WIN ? "C:\\fixture\\runtime" : "/fixture/runtime";
const WIN_URL = WIN ? "file:///C:/fixture/resources/index.html" : "file:///fixture/resources/index.html";

/* v270 周额度预测卡的逐日用量按需拉取：渲染端 pluginRequest("quota-usage-history", {sourceId}) →
 * 主进程转 quotaClient.refreshUsageHistory（源侧节流）。整文件 vm 加载（inject-report-range 夹具），
 * quota-client 用可编程桩替换：覆盖装配参数、合法请求的转发与回执、失败/拒绝/无效 id/无客户端/
 * 总开关关闭/旧 quota-client（无该方法）的降级，以及无 requestId 的单向请求不回执。 */

function loadPump({ config = "{}", quota, createClient } = {}) {
  const intervals = [], windows = [], demands = [];
  let id = 0, clientOpts = null;
  const mockFs = {
    readFileSync: file => String(file).endsWith("config.json") ? config : "",
    statSync: file => {
      if ([path.join(RT, "overlay.js"), path.join(RT, "zusage.py")].includes(file)) return { mtimeMs: 1, size: 1 };
      throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" });
    },
    readdirSync: () => [],
    existsSync: () => false,
    watch: () => ({ on() {}, close() {} }),
    writeFileSync() {}, renameSync() {}, unlinkSync() {},
  };
  const fake = Object.assign({
    view: () => ({}), sourcesConfig: () => [], tick: async () => {}, refresh: async () => false,
    refreshSource: () => false, noteProvider() {}, setProviders() {}, credentialsChanged() {},
    noteSnapshotExtras() {}, decryptHostValue: () => null, dispose() {},
    refreshUsageHistory: sourceId => { demands.push(sourceId); return Promise.resolve(true); },
  }, quota || {});
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
        execFile(cmd, args, opts, cb) { cb(new Error("no python in this fixture"), "", ""); },
      };
      if (name === "./quota-client.cjs") return {
        createQuotaClient: (opts) => {
          if (createClient) return createClient(opts);
          clientOpts = opts;
          return fake;
        },
        resolveQuotaPaths: () => ({ credsPath: "/q/credentials.json", credsDir: "/q/creds",
          customCfgPath: "", customCfgDir: "/q/custom", builtinCfgPath: "", builtinCfgDir: "/q/builtin" }),
        decryptValue: () => "plain", deriveCipherKey: () => "key",
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
  return { api: sandbox.module.exports.__zusageTest, intervals, addWindow, demands, clientOpts: () => clientOpts };
}

function resultsOf(wc) {
  return wc.pushes.filter(s => s.startsWith("window.__zusagePluginResult")).map(s => {
    const m = s.match(/__zusagePluginResult\((\{.*\})\)$/);
    assert.ok(m, "result payload parsed");
    return JSON.parse(m[1]);
  });
}

test("the quota client is assembled with usageHistory on-demand; a valid request is forwarded to refreshUsageHistory and answered ok", async () => {
  const h = loadPump();
  const wc = h.addWindow();
  assert.equal(h.clientOpts().usageHistory, "on-demand");
  assert.equal(h.clientOpts().historyPath, path.join(RT, "quota-history.json"));
  wc.requests.push({ action: "quota-usage-history", sourceId: "bigmodel", requestId: "u1" });
  await h.api.pollPluginRequests();
  await flush();
  assert.deepEqual(h.demands, ["bigmodel"]);
  assert.deepEqual(resultsOf(wc), [{ id: "u1", ok: true }]);
});

test("a source that cannot deliver usage right now (throttled without cache, failed, unsupported) answers ok:false without details", async () => {
  const h = loadPump({ quota: { refreshUsageHistory: () => Promise.resolve(false) } });
  const wc = h.addWindow();
  wc.requests.push({ action: "quota-usage-history", sourceId: "bigmodel", requestId: "u1" });
  await h.api.pollPluginRequests();
  await flush();
  assert.deepEqual(resultsOf(wc), [{ id: "u1", ok: false, error: "usage history unavailable" }]);
});

test("a rejected pull answers usage history failed instead of an unhandled rejection", async () => {
  const h = loadPump({ quota: { refreshUsageHistory: () => Promise.reject(new Error("boom")) } });
  const wc = h.addWindow();
  wc.requests.push({ action: "quota-usage-history", sourceId: "bigmodel", requestId: "u1" });
  await h.api.pollPluginRequests();
  await flush();
  assert.deepEqual(resultsOf(wc), [{ id: "u1", ok: false, error: "usage history failed" }]);
});

test("the overlay's fire-and-forget request (no requestId) still triggers the pull and pushes no receipt", async () => {
  const h = loadPump();
  const wc = h.addWindow();
  wc.requests.push({ action: "quota-usage-history", sourceId: "bigmodel" });
  await h.api.pollPluginRequests();
  await flush();
  assert.deepEqual(h.demands, ["bigmodel"]);
  assert.deepEqual(resultsOf(wc), []);
});

test("a missing, non-string or oversized source id is rejected before the client is touched", async () => {
  const h = loadPump();
  const wc = h.addWindow();
  const bad = [undefined, null, 7, "", "x".repeat(257)];
  bad.forEach((sourceId, i) => wc.requests.push(Object.assign({ action: "quota-usage-history", requestId: "bad" + i },
    sourceId === undefined ? {} : { sourceId })));
  await h.api.pollPluginRequests();
  await flush();
  assert.equal(h.demands.length, 0);
  const results = resultsOf(wc);
  assert.equal(results.length, bad.length);
  for (const r of results) assert.deepEqual(r, { id: r.id, ok: false, error: "invalid source" });
  wc.requests.push({ action: "quota-usage-history", sourceId: "bigmodel:bigmodel-api-2".padEnd(256, "x"), requestId: "edge" });   // 256 字符：上限含
  await h.api.pollPluginRequests();
  await flush();
  assert.equal(h.demands.length, 1);
  assert.equal(resultsOf(wc).slice(-1)[0].ok, true);
});

test("no client, a client without the method (older quota-client.cjs) or a disabled quota switch answer unavailable", async () => {
  const none = loadPump({ createClient: () => { throw new Error("quota assembly failed"); } });
  assert.equal(none.clientOpts(), null, "assembly failure leaves no client behind");
  const noClient = none.addWindow();
  noClient.requests.push({ action: "quota-usage-history", sourceId: "bigmodel", requestId: "u1" });
  await none.api.pollPluginRequests();
  await flush();
  assert.deepEqual(resultsOf(noClient), [{ id: "u1", ok: false, error: "usage history unavailable" }]);

  const older = loadPump({ quota: { refreshUsageHistory: undefined } });
  const noMethod = older.addWindow();
  noMethod.requests.push({ action: "quota-usage-history", sourceId: "bigmodel", requestId: "u1" });
  await older.api.pollPluginRequests();
  await flush();
  assert.deepEqual(resultsOf(noMethod), [{ id: "u1", ok: false, error: "usage history unavailable" }]);

  const off = loadPump({ config: JSON.stringify({ quota_enabled: false }) });
  const wcOff = off.addWindow();
  wcOff.requests.push({ action: "quota-usage-history", sourceId: "bigmodel", requestId: "u1" });
  await off.api.pollPluginRequests();
  await flush();
  assert.deepEqual(resultsOf(wcOff), [{ id: "u1", ok: false, error: "usage history unavailable" }]);
  assert.equal(off.demands.length, 0, "the master switch gates the network, as for quota-refresh");
});
