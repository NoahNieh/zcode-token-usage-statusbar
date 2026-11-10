"use strict";
/* v266 serve 快照门控的泵侧回归：本地请求带 same_ok、same 响应不重推、
 * 在途附属状态变化时用上一份快照补推、带 scopes 的远端请求不带 same_ok。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
const A = "remote:ssh:a:22:u:/p";
const flush = () => new Promise(resolve => setImmediate(resolve));

function loadPump() {
  let now = 100000, id = 0, cfgStamp = 1, settingStamp = 1;
  const timers = new Map(), intervals = [], procs = [], lines = [], windows = [], ipc = new EventEmitter();
  let cfg = { activity_min_ms: 300, remote: { poll_ms: 1000 } };
  class Clock extends Date { static now() { return now; } }
  const mockFs = {
    readFileSync: file => String(file).endsWith("config.json") ? JSON.stringify(cfg) : "{}",
    statSync: file => {
      // Windows 下 path.join 产出反斜杠：归一后匹配，否则 sourceStamp 恒为 missing，
      // settingChanged() 无法触发下一轮查询。
      const f = String(file).replace(/\\/g, "/");
      if (f.endsWith("/runtime/config.json")) return { mtimeMs: cfgStamp, size: 1 };
      if (f.endsWith("/.zcode/v2/setting.json")) return { mtimeMs: settingStamp, size: 1 };
      if (f.endsWith("/overlay.js") || f.endsWith("/zusage.py") || /db\.sqlite(-wal|-shm)?$/.test(f)) {
        return { mtimeMs: 1, size: 1 };
      }
      throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" });
    },
    existsSync: () => false, watch: () => ({ on() {} }), writeFileSync() {},
  };
  const sandbox = {
    __dirname: "/fixture/runtime", console: { error() {} }, Date: Clock,
    process: { resourcesPath: "C:\\fixture\\resources", execPath: process.execPath, uptime: () => 1,
      env: { ZCODE_DESKTOP_HOME_DIR: "/fixture/home" } }, module: { exports: {} },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    require(name) {
      if (name === "fs") return mockFs;
      if (["path", "url", "crypto"].includes(name)) return require(name);
      if (name === "electron") return { app: { getPath: () => "/fixture/home", on() {} }, webContents: { getAllWebContents: () => windows }, ipcMain: ipc };
      if (name === "child_process") return {
        spawn(cmd, args) {
          const p = new EventEmitter();
          p.args = args; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = new EventEmitter();
          p.stdin.writable = true; p.stdin.write = line => lines.push(JSON.parse(line));
          p.kill = () => { p.killed = true; p.stdin.writable = false; };
          procs.push(p); return p;
        }, execFile() {},
      };
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  function addWindow(identity, sid = "sA") {
    const wc = { id: windows.length + 1, page: { s: [sid], w: identity ? { [sid]: [identity] } : {}, p: {} }, pushes: [],
      getType: () => "window", isDestroyed: () => false, getURL: () => "file:///C:/fixture/resources/index.html",
      executeJavaScript: async js => {
        if (js.includes("var a=window.__zusageWantSids")) return JSON.stringify(wc.page);
        if (js.startsWith("window.__zusageUpdate")) wc.pushes.push(js);
        return "null";
      },
    };
    windows.push(wc); return wc;
  }
  return {
    api: sandbox.module.exports.__zusageTest, lines, procs, windows, timers, intervals, addWindow,
    workspace(wc, identities) { ipc.emit("zcode:sync-web-remote-control-workspaces", { sender: wc }, identities.map(workspaceIdentity => ({ workspacePath: "/p", kind: "remote", workspaceIdentity }))); },
    respond(payload, p = procs.at(-1)) { p.stdout.emit("data", Buffer.from(JSON.stringify(payload) + "\n")); },
    settingChanged() { settingStamp++; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}

test("本地请求带 same_ok，带 scopes 的远端请求不带", async () => {
  const local = loadPump();
  local.addWindow(null);
  local.api.maybeSpawn(); await flush();
  assert.equal(local.lines.length, 1);
  assert.equal(local.lines[0].same_ok, 1);
  assert.deepEqual([...local.lines[0].sids], ["sA"]);
  assert.deepEqual([...local.lines[0].scopes], []);

  const remote = loadPump();
  const wc = remote.addWindow(A);
  remote.workspace(wc, [A]);
  remote.api.maybeSpawn(); await flush();
  assert.equal(remote.lines.length, 1);
  assert.equal(remote.lines[0].same_ok, undefined, "远端数据可独立变化，服务端不缓存");
  assert.deepEqual(remote.lines[0].scopes.map(s => s.workspaceIdentity), [A]);
});

test("same 响应不重推；在途附属状态变化时补推上一份快照", async () => {
  const f = loadPump();
  const wc = f.addWindow(null);
  f.api.maybeSpawn(); await flush();
  f.respond({ session: { sid: "sA" }, recent: [], today: {} }); await flush();
  assert.equal(wc.pushes.length, 1);

  f.settingChanged();
  f.api.maybeSpawn(); await flush(); await f.advance(400);
  assert.equal(f.lines.length, 2);
  assert.equal(f.lines[1].same_ok, 1);
  f.respond({ same: 1 }); await flush();
  assert.equal(wc.pushes.length, 1, "无变化的 same 不应重推 153KB 整包");

  f.settingChanged();
  f.api.maybeSpawn(); await flush(); await f.advance(400);
  assert.equal(f.lines.length, 3);
  // 请求已发出、响应未回时窗口远端证据变化：服务端仍会回 same，泵必须补推上一份快照
  f.api.ipcState().remoteEvidence.set(wc.id, true);
  f.respond({ same: 1 }); await flush();
  assert.equal(wc.pushes.length, 2);
  assert.match(wc.pushes[1], /"remote_evidence":true/);
});

test("整包响应仍走原推送路径，并刷新附属状态指纹", async () => {
  const f = loadPump();
  const wc = f.addWindow(null);
  f.api.maybeSpawn(); await flush();
  f.respond({ session: { sid: "sA" }, recent: [], today: {} }); await flush();
  f.settingChanged();
  f.api.maybeSpawn(); await flush(); await f.advance(400);
  f.respond({ session: { sid: "sA" }, today: { requests: 2 } }); await flush();
  assert.equal(wc.pushes.length, 2);
  assert.match(wc.pushes[1], /"requests":2/);
});
