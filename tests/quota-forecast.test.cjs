const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Q = require(path.join(__dirname, "..", "quota-client.cjs"));

/* v269 BigModel 周额度预测：周窗采样序列（appendSample）、预测（forecastWeekly）与调度器集成
 * （ok 结算记样本 / view 白名单 / 落盘回读 / dispose 迟到结算），以及曲线的真数据来源——monitor 的
 * 按时间范围用量接口（parseUsageHistory / historyDaysToPts + 调度器拉取、节流、回退）。
 * 夹具沿用 quota-client.test.cjs 的注入接缝：now 时钟、fetchImpl、readFile（JSON 读取器，这里直接
 * 返回凭据对象）、enc:v1 测试凭据。订阅端点回非 JSON（maybeGetJson 静默降级），不依赖订阅元数据的
 * 有效期夹具；逐日用量接口缺省回 404（曲线退回采样序列，原有采样用例的断言不变）。 */
const ENV = { ZCODE_CREDENTIAL_SECRET: "test-secret" };
const KEY = Q.deriveCipherKey(ENV);
function encryptValue(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "enc:v1:" + iv.toString("base64url") + "." + c.getAuthTag().toString("base64url") + "." + ct.toString("base64url");
}
function deferred() {
  let resolve;
  const p = new Promise((a) => { resolve = a; });
  return { promise: p, resolve };
}
function fakeRes(status, body) {
  return { status, headers: { get: () => null }, text: async () => body };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
const T0 = Date.UTC(2026, 10, 23, 0, 0, 0);   // 周期起点 2026-11-23T00:00Z
const RESET = T0 + WEEK;
const BIGMODEL = "account:bigmodel-individual-coding-plan";
/* 逐日用量用例用本地零点起的周期：期望值不依赖测试机时区（11 月下旬无夏令时切换） */
const L0 = new Date(2026, 10, 23, 0, 0, 0).getTime();   // 2026-11-23 00:00 本地
const LRESET = L0 + WEEK;
const pad2 = (n) => (n < 10 ? "0" : "") + n;
function fmtLocal(ms) {   // monitor 时间范围参数的墙钟格式
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}
const hourLabel = (ms) => fmtLocal(ms).slice(0, 16);   // "YYYY-MM-DD HH:mm"
const dayLabel = (ms) => fmtLocal(ms).slice(0, 10);    // "YYYY-MM-DD"
function usageBody(labels, tokens) {   // monitor model-usage 响应（小时粒度）
  return JSON.stringify({ code: 200, msg: "操作成功", success: true, data: {
    granularity: "hourly", x_time: labels, tokensUsage: tokens, modelCallCount: tokens.map(() => 3),
    totalUsage: { totalModelCallCount: 3 * tokens.length, totalTokensUsage: tokens.reduce((a, b) => a + b, 0), modelSummaryList: [] },
  } });
}
/* 小时桶序列：[[桶起点 ms, token], …]，从 from 到 to（不含）逐小时 */
function hourly(from, to, tokOf) {
  const out = [];
  for (let t = Math.floor(from / HOUR) * HOUR; t < to; t += HOUR) out.push([t, tokOf ? tokOf(t) : 0]);
  return out;
}
/* 夹具用量（本地日）：11-23 = 6M（3 桶×2M）、11-24 = 12M（6 桶×2M）、11-25 = 0（不出桶）、11-26 = 18M（9 桶×2M）、
 * 11-27 = 24M（06:00 前两桶×12M）；合计 60M */
function fixtureTok(t) {
  const day = Math.round((new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()).getTime() - L0) / DAY);
  const hour = new Date(t).getHours();
  if (day === 0) return hour < 3 ? 2e6 : 0;
  if (day === 1) return hour < 6 ? 2e6 : 0;
  if (day === 2) return 0;
  if (day === 3) return hour < 9 ? 2e6 : 0;
  if (day === 4) return hour < 2 ? 12e6 : 0;
  return 0;
}
const LNOW = L0 + 4 * DAY + 6 * HOUR;   // 2026-11-27 06:00 本地
function fixtureRows(shiftMs) {
  return hourly(L0, LNOW, fixtureTok).filter((r) => r[1] > 0)
    .map((r) => [hourLabel(r[0] + (shiftMs || 0)), r[1]]);
}
const HISTORY_URL = "https://bigmodel.cn/api/monitor/usage/model-usage";

/* monitor 响应：currentValue/usage = pct/1000 → 已用 % 精确到 0.1；reset 传 null 得到无重置时刻的周窗 */
function monitorBody(pct, reset) {
  const limits = [{ type: "TOKENS_LIMIT", unit: 3, percentage: 26, nextResetTime: T0 + 5 * HOUR }];
  if (reset !== undefined) {
    limits.push({ type: "TOKENS_LIMIT", unit: 6, usage: 1000, currentValue: Math.round(pct * 10), percentage: Math.floor(pct), nextResetTime: reset });
  }
  return JSON.stringify({ success: true, data: { level: "max", limits } });
}

function makeClient({ historyPath, env, onUpdate } = {}) {
  const creds = { "oauth:bigmodel:access_token": encryptValue("jwt.test.token"), "oauth:zai:access_token": encryptValue("jwt.test.token") };
  const clock = { t: T0 + 4 * DAY };
  const calls = [], hist = [];   // calls：额度请求；hist：逐日用量请求 {url, init}
  let respond = () => fakeRes(200, monitorBody(10, RESET));
  let respondHist = () => fakeRes(404, "");
  const client = Q.createQuotaClient({
    env: Object.assign({}, ENV, env || {}), now: () => clock.t, credsPath: "/virtual/credentials.json",
    readFile: () => creds,
    fetchImpl: (url, init) => {
      if (url.indexOf("/api/biz/subscription/list") >= 0) return Promise.resolve(fakeRes(200, "<html>"));
      if (url.indexOf("/api/monitor/usage/model-usage") >= 0) { hist.push({ url, init }); return Promise.resolve(respondHist(url, hist.length)); }
      calls.push(url);
      return Promise.resolve(respond(url, calls.length));
    },
    ...(historyPath ? { historyPath } : {}),
    ...(onUpdate ? { onUpdate } : {}),
  });
  return { client, clock, calls, hist, creds, respond: (fn) => { respond = fn; }, respondHist: (fn) => { respondHist = fn; } };
}
/* 在时刻 t 以给定已用 % 结算一次：force=true 绕过 TTL（chip 点击同款），false 走自然 tick */
async function settleAt(h, t, pct, reset, force = true) {
  h.respond(() => fakeRes(200, monitorBody(pct, reset)));
  h.clock.t = t;
  const started = force ? h.client.refresh() : h.client.tick();
  await flush();
  return started;
}
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-qf-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { } });   // 只清自己建的临时目录
  return dir;
}

/* ---------- 纯函数 ---------- */
test("appendSample: new series per reset, same-instant overwrite, rollback/drop restart, capped thinning keeps endpoints", () => {
  let s = Q.appendSample(null, 1000, 5, RESET);
  assert.deepEqual(s, { reset: RESET, pts: [[1000, 5]] });
  s = Q.appendSample(s, 2000, 8, RESET);
  assert.deepEqual(s.pts, [[1000, 5], [2000, 8]]);
  s = Q.appendSample(s, 2000, 9, RESET);                       // 时钟未推进的重复结算：覆盖
  assert.deepEqual(s.pts, [[1000, 5], [2000, 9]]);
  s = Q.appendSample(s, 1500, 1, RESET);                       // 时钟回拨：重开
  assert.deepEqual(s.pts, [[1500, 1]]);
  s = Q.appendSample(s, 2500, 40, RESET);
  s = Q.appendSample(s, 3000, 12, RESET);                      // 同周期已用回落 28 点：换账号/换套餐，重开
  assert.deepEqual(s.pts, [[3000, 12]]);
  s = Q.appendSample(s, 3500, 12.5, RESET);                    // 容差内的波动不触发重开
  s = Q.appendSample(s, 4000, 11.5, RESET);
  assert.deepEqual(s.pts, [[3000, 12], [3500, 12.5], [4000, 11.5]]);
  s = Q.appendSample(s, 9000, 3, RESET + WEEK);                // 新周期
  assert.deepEqual(s, { reset: RESET + WEEK, pts: [[9000, 3]] });
  /* 下面两条与「已用回落」结果相同，单独用不回落的样本把分支区分开 */
  s = Q.appendSample(null, 1000, 5, RESET);
  s = Q.appendSample(s, 2000, 9, RESET);
  s = Q.appendSample(s, 1500, 9, RESET);                       // 时钟回拨但已用未回落：仍须重开（否则样本乱序）
  assert.deepEqual(s.pts, [[1500, 9]]);
  s = Q.appendSample(null, 1000, 2, RESET);
  s = Q.appendSample(s, 2000, 5, RESET + WEEK);                // 新周期首个采样高于上周期末值：按 resetsAt 重开
  assert.deepEqual(s, { reset: RESET + WEEK, pts: [[2000, 5]] });

  let big = null;
  for (let i = 0; i < 1000; i++) big = Q.appendSample(big, i * MIN, i / 10, RESET);
  assert.ok(big.pts.length <= Q.FORECAST_MAX_PTS, "capped: " + big.pts.length);
  assert.ok(big.pts.length >= Q.FORECAST_MAX_PTS / 2, "thinned roughly by half, not collapsed: " + big.pts.length);
  assert.deepEqual(big.pts[0], [0, 0]);                        // 首尾恒留
  assert.deepEqual(big.pts[big.pts.length - 1], [999 * MIN, 99.9]);
  for (let i = 1; i < big.pts.length; i++) assert.ok(big.pts[i][0] > big.pts[i - 1][0], "time-ordered");
  assert.equal(Q.appendSample(null, 1, 1, RESET).pts.length, 1);
});

test("forecastWeekly: to-date average rate, hit/end extrapolation, minute offsets, and every fail-closed shape", () => {
  const t = T0 + 2 * DAY + 6 * HOUR;   // 周期已过 2.25 天
  let s = Q.appendSample(null, T0 + DAY, 20, RESET);
  s = Q.appendSample(s, t, 45, RESET);
  const f = Q.forecastWeekly(s, t);
  assert.equal(f.start, T0);                                    // 周期起点 = resetsAt − 7 天
  assert.equal(f.reset, RESET);
  assert.equal(f.pct, 45);
  assert.equal(f.at, t);
  assert.ok(Math.abs(f.avg - 20) < 0.001, "45% over 2.25 days = 20 %/day, got " + f.avg);
  assert.ok(Math.abs(f.hit - (t + 2.75 * DAY)) < 2, "55% left at 20 %/day → 2.75 days later, inside the window");
  assert.ok(Math.abs(f.end - 140) < 0.06, "45 + 20 × 4.75 remaining days = 140, got " + f.end);
  assert.deepEqual(f.pts, [[1440, 20], [3240, 45]]);            // 整分钟偏移

  const early = Q.forecastWeekly(Q.appendSample(null, T0 + 10 * MIN, 5, RESET), T0 + 10 * MIN);
  assert.equal(early.avg, 120);                                 // 周期头不足 1 小时按 1 小时摊平（5% / 1h × 24）
  assert.ok(early.hit > T0 + 10 * MIN && early.hit < RESET);

  const safe = Q.forecastWeekly(Q.appendSample(null, T0 + 3 * DAY, 30, RESET), T0 + 3 * DAY);
  assert.equal(safe.avg, 10);                                   // 10 %/天 → 还需 7 天，晚于 4 天后的重置
  assert.equal(safe.hit, null);
  assert.equal(safe.end, 70);

  const idle = Q.forecastWeekly(Q.appendSample(null, T0 + DAY, 0, RESET), T0 + DAY);
  assert.equal(idle.avg, 0);
  assert.equal(idle.hit, null);
  assert.equal(idle.end, 0);

  s = Q.appendSample(null, T0 + DAY, 50, RESET);
  s = Q.appendSample(s, T0 + 2 * DAY, 100, RESET);
  s = Q.appendSample(s, T0 + 3 * DAY, 100, RESET);
  const done = Q.forecastWeekly(s, T0 + 3 * DAY);
  assert.equal(done.hit, T0 + 2 * DAY);                         // 已达上限：首个 ≥100% 的采样时刻
  assert.equal(done.end, 100);                                  // 不再外推

  assert.equal(Q.forecastWeekly(null, T0), null);
  assert.equal(Q.forecastWeekly({ reset: "2026-11-30T00:00:00Z", pts: [[T0, 5]] }, T0), null);   // 重置时刻非数值（ISO 串）不猜
  assert.equal(Q.forecastWeekly({ reset: RESET, pts: [] }, T0), null);
  assert.equal(Q.forecastWeekly(Q.appendSample(null, T0, 5, RESET), T0), null);                  // 周期起点之前
  assert.equal(Q.forecastWeekly(Q.appendSample(null, RESET, 5, RESET), RESET), null);            // 已到重置时刻
});

/* ---------- 调度器集成 ---------- */
test("client: bigmodel weekly window gets a forecast after the ok settle, mirrored top-level, window shape untouched", async () => {
  const h = makeClient();
  h.client.noteProvider(BIGMODEL);
  await settleAt(h, T0 + 4 * DAY, 40, RESET);
  const v = h.client.view();
  assert.equal(v.status, "ok");
  assert.deepEqual(v.windows.weekly, { percent: 40, resetsAt: RESET, details: [] });   // 窗口条目形状不变，预测走独立字段
  const f = v.forecast;
  assert.ok(f, "forecast exposed on the entry");
  assert.equal(f.reset, RESET);
  assert.equal(f.start, T0);
  assert.equal(f.pct, 40);
  assert.equal(f.at, T0 + 4 * DAY);
  assert.ok(Math.abs(f.avg - 10) < 0.001, "4 days for 40% → 10 %/day, got " + f.avg);
  assert.equal(f.hit, null);                                    // 还需 6 天 > 剩余 3 天：本周期内不会用尽
  assert.equal(f.end, 70);
  assert.deepEqual(f.pts, [[5760, 40]]);
  assert.equal(v.sources.bigmodel.forecast, f);                  // 顶层镜像与 sources 条目同一对象
  h.client.dispose();
});

test("client: samples accumulate across natural TTL refreshes; a repeated settle at the same instant adds no sample", async () => {
  const h = makeClient();
  h.client.noteProvider(BIGMODEL);
  await settleAt(h, T0 + 4 * DAY, 40, RESET, false);
  assert.equal(await settleAt(h, T0 + 4 * DAY + 5 * MIN, 40, RESET, false), 0, "inside TTL: no request");   // 快照/view 不产生样本
  await settleAt(h, T0 + 5 * DAY, 55, RESET, false);
  await settleAt(h, T0 + 5 * DAY + 12 * HOUR, 60, RESET, false);
  const f = h.client.view().forecast;
  assert.deepEqual(f.pts, [[5760, 40], [7200, 55], [7920, 60]]);
  assert.equal(f.at, T0 + 5 * DAY + 12 * HOUR);
  assert.ok(Math.abs(f.avg - 60 / 5.5) < 0.001, "60% over 5.5 days, got " + f.avg);
  assert.equal(f.hit, null);                                    // 10.9 %/天 → 还需 3.67 天 > 剩余 1.5 天
  assert.ok(Math.abs(f.end - (60 + (60 / 5.5) * 1.5)) < 0.06, "60 + 10.9 × 1.5 remaining days, got " + f.end);
  assert.equal(h.calls.length, 3, "TTL 内的 tick 不发请求");
  await settleAt(h, T0 + 5 * DAY + 12 * HOUR, 60, RESET, true);  // 同一时刻再结算（手动刷新）：覆盖不追加
  assert.deepEqual(h.client.view().forecast.pts, [[5760, 40], [7200, 55], [7920, 60]]);
  assert.equal(h.calls.length, 4);
  h.client.dispose();
});

test("client: a new weekly window starts a fresh series and the forecast follows it", async () => {
  const h = makeClient();
  h.client.noteProvider(BIGMODEL);
  await settleAt(h, RESET - HOUR, 96, RESET);
  assert.equal(h.client.view().forecast.pct, 96);
  await settleAt(h, RESET + HOUR, 3, RESET + WEEK);
  const f = h.client.view().forecast;
  assert.equal(f.reset, RESET + WEEK);
  assert.equal(f.start, RESET);
  assert.deepEqual(f.pts, [[60, 3]], "previous window samples are not carried over");
  assert.equal(f.end, 504);                                     // 3% in 1 hour → 72 %/day，按剩余 167 小时外推
  h.client.dispose();
});

test("client: forecast is BigModel-only — zai family and a weekly window without a reset time get none", async () => {
  const h = makeClient();
  h.client.noteProvider("account:zai-pro");
  await settleAt(h, T0 + 4 * DAY, 40, RESET);
  let v = h.client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.windows.weekly.percent, 40);
  assert.equal(v.forecast, undefined);
  assert.equal(v.sources.zai.forecast, undefined);
  h.client.dispose();

  const h2 = makeClient();
  h2.client.noteProvider(BIGMODEL);
  await settleAt(h2, T0 + 4 * DAY, 40, RESET);
  assert.equal(h2.client.view().forecast.reset, RESET);
  await settleAt(h2, T0 + 4 * DAY + HOUR, 42, null);            // 接口不再给重置时刻：窗口仍在，旧周期的预测不得继续暴露
  v = h2.client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.windows.weekly.resetsAt, null);
  assert.equal(v.windows.weekly.percent, 42);
  assert.equal(v.forecast, undefined);
  assert.equal(v.sources.bigmodel.forecast, undefined);
  h2.client.dispose();
});

test("client: without historyPath the forecast works in memory and nothing is written next to the virtual secrets path", async () => {
  const h = makeClient();
  h.client.noteProvider(BIGMODEL);
  await settleAt(h, T0 + 4 * DAY, 40, RESET);
  assert.equal(h.client.view().forecast.pct, 40);
  assert.equal(fs.existsSync(path.join(path.dirname("/virtual/quota-secrets.json"), "quota-history.json")), false);
  h.client.dispose();
});

/* ---------- 落盘 ---------- */
test("history file: written on the ok settle with numbers only, reloaded and extended by a fresh client", async (t) => {
  const file = path.join(tmpDir(t), "quota-history.json");
  const h1 = makeClient({ historyPath: file });
  h1.client.noteProvider(BIGMODEL);
  assert.equal(fs.existsSync(file), false, "nothing written before the first sample");
  await settleAt(h1, T0 + 4 * DAY, 40, RESET);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")),
    { v: 1, series: { bigmodel: { reset: RESET, pts: [[T0 + 4 * DAY, 40]] } } });
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /jwt|oauth|access_token|authorization|plan|productName/, "numbers and timestamps only");
  h1.client.dispose();
  assert.equal(fs.existsSync(file + ".tmp"), false, "atomic write leaves no temp file");

  const h2 = makeClient({ historyPath: file });                  // 模拟热换/重启：新实例回读后延续同一序列
  h2.client.noteProvider(BIGMODEL);
  await settleAt(h2, T0 + 5 * DAY, 55, RESET);
  const f = h2.client.view().forecast;
  assert.deepEqual(f.pts, [[5760, 40], [7200, 55]]);
  assert.ok(Math.abs(f.avg - 11) < 0.001, "55% over 5 days, got " + f.avg);
  h2.client.dispose();
});

test("history file: corrupt content starts clean; malformed and expired series are dropped on load and on save", async (t) => {
  const file = path.join(tmpDir(t), "quota-history.json");
  fs.writeFileSync(file, "{not json");
  const h = makeClient({ historyPath: file });
  h.client.noteProvider(BIGMODEL);
  await settleAt(h, T0 + 4 * DAY, 40, RESET);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).series, { bigmodel: { reset: RESET, pts: [[T0 + 4 * DAY, 40]] } });
  h.client.dispose();

  fs.writeFileSync(file, JSON.stringify({ v: 1, series: {
    expired: { reset: T0 + HOUR, pts: [[T0, 1], [T0 + MIN, 2]] },            // 周期已过：加载即丢
    lone: { reset: RESET, pts: [[T0, 5], ["x", 5]] },                          // 非法样本过滤；单点序列照样保留
    bigmodel: { reset: RESET, pts: [[T0 + 3 * DAY, 30], [T0 + 2 * DAY, 20], [T0 + 3 * DAY + HOUR, 900]] },   // 乱序按时间排；越界已用丢弃
    soon: { reset: T0 + 4 * DAY + HOUR, pts: [[T0 + 4 * DAY, 1], [T0 + 4 * DAY + MIN, 2]] },   // 加载时未过期
  }, secret: "x" }));                                                        // 多余键靠形状门忽略，不报错
  const h2 = makeClient({ historyPath: file });
  assert.deepEqual([...h2.client._series.keys()].sort(), ["bigmodel", "lone", "soon"], "expired is dropped on load; the rest is kept");
  h2.client.noteProvider(BIGMODEL);
  await settleAt(h2, T0 + 4 * DAY + 2 * HOUR, 40, RESET);      // 跨过 soon 的重置时刻：保存时清掉
  assert.deepEqual(h2.client.view().forecast.pts, [[2880, 20], [4320, 30], [5880, 40]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { v: 1, series: {
    lone: { reset: RESET, pts: [[T0, 5]] },
    bigmodel: { reset: RESET, pts: [[T0 + 2 * DAY, 20], [T0 + 3 * DAY, 30], [T0 + 4 * DAY + 2 * HOUR, 40]] },   // expired/soon 已清
  } });
  h2.client.dispose();
});

test("history file: a settle that lands after dispose records no sample and writes nothing", async (t) => {
  const file = path.join(tmpDir(t), "quota-history.json");
  const d = deferred();
  const h = makeClient({ historyPath: file });
  h.client.noteProvider(BIGMODEL);
  h.respond(() => d.promise);
  h.clock.t = T0 + 4 * DAY;
  h.client.refresh();
  h.client.dispose();                                           // 热换：在途请求被 abort，但结算仍可能迟到
  d.resolve(fakeRes(200, monitorBody(40, RESET)));
  await flush();
  assert.equal(fs.existsSync(file), false, "late settle must not write the shared file");
  assert.equal(h.client.view().forecast, undefined);
  assert.deepEqual(h.client._state.forecast, undefined);
});

test("history file: an unwritable path degrades to in-memory without breaking the quota chain", async (t) => {
  const file = path.join(tmpDir(t), "no-such-dir", "quota-history.json");   // 目录不存在：写入失败
  const h = makeClient({ historyPath: file });
  h.client.noteProvider(BIGMODEL);
  await settleAt(h, T0 + 4 * DAY, 40, RESET);
  const v = h.client.view();
  assert.equal(v.status, "ok");
  assert.equal(v.forecast.pct, 40);
  assert.equal(fs.existsSync(file), false);
  h.client.dispose();
});

/* ---------- 逐日用量：monitor 的按时间范围用量接口（纯函数） ---------- */
const fixBody = (shiftMs) => { const rows = fixtureRows(shiftMs); return usageBody(rows.map((r) => r[0]), rows.map((r) => r[1])); };
/* 夹具用量折成的本地日：11-23 6M、11-24 12M、11-26 18M、11-27（当日）24M */
const FIX_DAYS = [[L0, L0 + DAY, 6e6], [L0 + DAY, L0 + 2 * DAY, 12e6], [L0 + 3 * DAY, L0 + 4 * DAY, 18e6], [L0 + 4 * DAY, L0 + 5 * DAY, 24e6]];

test("parseUsageHistory: hourly buckets fold into local days, vendor wall-clock labels shift to the machine timezone, the bucket straddling the period start is prorated", () => {
  assert.deepEqual(Q.parseUsageHistory(JSON.parse(fixBody()), L0, LNOW), FIX_DAYS);          // 无用量日（11-25）不出行
  assert.deepEqual(Q.parseUsageHistory(JSON.parse(fixBody(8 * HOUR)), L0, LNOW), FIX_DAYS); // 服务端 UTC+8 标签：按首桶推偏移，日界线不变
  const start = L0 + 10 * MIN, rows = [[L0, 600], [L0 + HOUR, 600]];
  const body = { success: true, data: { x_time: rows.map((r) => hourLabel(r[0])), tokensUsage: rows.map((r) => r[1]) } };
  assert.deepEqual(Q.parseUsageHistory(body, start, L0 + 2 * HOUR), [[L0, L0 + DAY, 1100]]); // 首桶跨周期起点：按 50/60 折算
  body.data.x_time.push(hourLabel(L0 - HOUR)); body.data.tokensUsage.push(999);              // 乱序混入整桶在周期之前的桶
  assert.deepEqual(Q.parseUsageHistory(body, start, L0 + 2 * HOUR), [[L0, L0 + DAY, 1100]]);
  const daily = { success: true, data: { granularity: "daily", x_time: [dayLabel(L0), dayLabel(L0 + DAY), dayLabel(L0 + 5 * DAY)], tokensUsage: [2400, 4800, 7777] } };
  assert.deepEqual(Q.parseUsageHistory(daily, L0 + 6 * HOUR, L0 + DAY + 12 * HOUR), [[L0, L0 + DAY, 1800], [L0 + DAY, L0 + 2 * DAY, 4800]]);   // 日粒度：首日按 18/24 折算；查询终点之后的桶丢弃
});

test("parseUsageHistory: every malformed shape is rejected, and buckets of another granularity or without numeric usage are dropped", () => {
  assert.deepEqual(Q.parseUsageHistory({ success: true, data: { x_time: [hourLabel(L0)], tokensUsage: [600] } }, L0 + 30 * MIN, LNOW), [[L0, L0 + DAY, 300]]);   // 首桶跨起点 30 分钟：折半
  const ok = { success: true, data: { x_time: [hourLabel(L0)], tokensUsage: [600] } };
  for (const bad of [null, "x", 7, {}, { data: [] }, { success: false, data: ok.data }, { success: true },
    { success: true, data: { x_time: [], tokensUsage: [] } }, { success: true, data: { x_time: [hourLabel(L0)] } },
    { success: true, data: { tokensUsage: [600] } },
    { success: true, data: { x_time: [hourLabel(L0), hourLabel(L0 + HOUR)], tokensUsage: [600] } },   // 长度不等
    { success: true, data: { x_time: ["soon", hourLabel(L0)], tokensUsage: [600, 600] } },             // 首标签解析不了
    { success: true, data: { x_time: [1795000000000], tokensUsage: [600] } },                          // 时间戳数字标签
    { success: true, data: { x_time: [hourLabel(L0 + 20 * HOUR)], tokensUsage: [600] } }]) {           // 首桶不含查询起点（偏移超 14 小时）
    assert.equal(Q.parseUsageHistory(bad, L0 + 30 * MIN, LNOW), null, JSON.stringify(bad));
  }
  const mixed = { success: true, data: { x_time: [hourLabel(L0), dayLabel(L0 + DAY), hourLabel(L0 + HOUR)], tokensUsage: [600, 999, "abc"] } };
  assert.deepEqual(Q.parseUsageHistory(mixed, L0, LNOW), [[L0, L0 + DAY, 600]]);
  assert.deepEqual(Q.parseUsageHistory({ success: true, data: { x_time: [hourLabel(L0), hourLabel(L0 + HOUR)], tokensUsage: [-5, 0] } }, L0, LNOW), []);
});

test("historyDaysToPts: cumulative percent at each finished local midnight scaled to the latest sample; no usage or 0% hands over to the samples", () => {
  assert.deepEqual(Q.historyDaysToPts(FIX_DAYS, L0, LNOW, 30), [[L0 + DAY, 3], [L0 + 2 * DAY, 9], [L0 + 3 * DAY, 9], [L0 + 4 * DAY, 18]]);   // 无用量日（11-25）零点也落顶点：折线走平
  const thirds = [[L0, L0 + DAY, 1], [L0 + DAY, L0 + 2 * DAY, 1], [L0 + 2 * DAY, L0 + 3 * DAY, 1], [L0 + 4 * DAY, L0 + 5 * DAY, 7]];
  assert.deepEqual(Q.historyDaysToPts(thirds, L0, LNOW, 50), [[L0 + DAY, 5], [L0 + 2 * DAY, 10], [L0 + 3 * DAY, 15], [L0 + 4 * DAY, 15]]);   // 11-26 无桶：0% 增量，顶点照落
  const two = [[L0, L0 + DAY, 1], [L0 + DAY, L0 + 2 * DAY, 1], [L0 + 2 * DAY, L0 + 3 * DAY, 1]];
  assert.deepEqual(Q.historyDaysToPts(two, L0, L0 + 2 * DAY + HOUR, 50), [[L0 + DAY, 16.7], [L0 + 2 * DAY, 33.3]]);   // 进位到 0.1
  assert.deepEqual(Q.historyDaysToPts([[L0 + 4 * DAY, L0 + 5 * DAY, 5]], L0, LNOW, 30), [[L0 + DAY, 0], [L0 + 2 * DAY, 0], [L0 + 3 * DAY, 0], [L0 + 4 * DAY, 0]]);   // 只有当日有用量：之前各日 0% 走平
  assert.equal(Q.historyDaysToPts([], L0, LNOW, 30), null);
  assert.equal(Q.historyDaysToPts([[L0, L0 + DAY, 0]], L0, LNOW, 30), null);
  assert.equal(Q.historyDaysToPts(FIX_DAYS, L0, LNOW, 0), null);
});

/* ---------- 逐日用量：调度器集成 ---------- */
test("usage history: the ok settle pulls the period's hourly usage once and the curve becomes a day-by-day polyline scaled to the current percent", async () => {
  const h = makeClient();
  h.client.noteProvider(BIGMODEL);
  h.respondHist(() => fakeRes(200, fixBody()));
  await settleAt(h, LNOW, 30, LRESET);
  assert.equal(h.hist.length, 1);
  assert.equal(h.hist[0].url, HISTORY_URL + "?startTime=" + encodeURIComponent(fmtLocal(L0)) + "&endTime=" + encodeURIComponent(fmtLocal(LNOW)));
  assert.equal(h.hist[0].init.headers.authorization, "jwt.test.token");   // 与额度请求同款裸 authorization
  const f = h.client.view().forecast;
  assert.deepEqual(f.pts, [[1440, 3], [2880, 9], [4320, 9], [5760, 18], [6120, 30]]);   // 各完结日零点的累计 %（等比标定到当前 30%）+ (now, 30)
  assert.equal(f.pct, 30);
  assert.ok(Math.abs(f.avg - 30 / 4.25) < 0.001);
  assert.equal(f.hit, null);
  assert.equal(f.end, 49.4);
  assert.equal(h.client.view().sources.bigmodel.forecast, f);
  assert.deepEqual(h.client._series.get("bigmodel").pts, [[LNOW, 30]], "采样序列照旧记录（接口不可用时的回退）");
  h.client.dispose();
});

test("usage history: pulled at most once per 5 minutes — later settles rescale the cached daily usage, and a new period pulls again", async () => {
  const h = makeClient();
  h.client.noteProvider(BIGMODEL);
  h.respondHist(() => fakeRes(200, fixBody()));
  await settleAt(h, LNOW, 30, LRESET);
  await settleAt(h, LNOW + 4 * MIN, 45, LRESET);      // 节流窗口内：不重拉，按新值重新标定
  assert.equal(h.hist.length, 1);
  assert.deepEqual(h.client.view().forecast.pts, [[1440, 4.5], [2880, 13.5], [4320, 13.5], [5760, 27], [6124, 45]]);
  await settleAt(h, LNOW + 6 * MIN, 46, LRESET);      // 越过 5 分钟：重拉
  assert.equal(h.hist.length, 2);
  assert.ok(h.hist[1].url.endsWith("endTime=" + encodeURIComponent(fmtLocal(LNOW + 6 * MIN))));
  assert.deepEqual(h.client.view().forecast.pts, [[1440, 4.6], [2880, 13.8], [4320, 13.8], [5760, 27.6], [6126, 46]]);
  await settleAt(h, LRESET - 2 * MIN, 99, LRESET);       // 周期末：距上次拉取已久，重拉
  assert.equal(h.hist.length, 3);
  await settleAt(h, LRESET + 2 * MIN, 3, LRESET + WEEK); // 新周期：节流按周期计，4 分钟后也立即拉
  assert.equal(h.hist.length, 4);
  assert.ok(h.hist[3].url.indexOf("startTime=" + encodeURIComponent(fmtLocal(LRESET)) + "&") > 0);
  assert.deepEqual(h.client.view().forecast.pts, [[2, 3]], "the stale fixture buckets belong to the previous period and are not adopted");
  h.client.dispose();
});

test("usage history: a new period never reuses the previous period's days when its own pull fails", async () => {
  const h = makeClient();
  h.client.noteProvider(BIGMODEL);
  h.respondHist(() => fakeRes(200, fixBody()));
  await settleAt(h, LNOW, 30, LRESET);
  assert.equal(h.client.view().forecast.pts.length, 5);
  h.respondHist(() => fakeRes(500, "boom"));
  await settleAt(h, LRESET + 2 * DAY + HOUR, 3, LRESET + WEEK);
  assert.equal(h.hist.length, 2);
  assert.deepEqual(h.client.view().forecast.pts, [[2940, 3]]);
  h.client.dispose();
});

test("usage history: a response that lands after the source's credential changed is dropped", async () => {
  const d = deferred();
  const h = makeClient();
  h.respondHist(() => d.promise);
  h.client.noteProvider(BIGMODEL);
  await settleAt(h, LNOW, 30, LRESET);                  // 额度 ok，用量请求挂起
  const st = h.client._states.get("bigmodel"), fp = st.fingerprint;
  h.creds["oauth:bigmodel:access_token"] = encryptValue("jwt.other.token");   // 换账号登录
  h.respond(() => fakeRes(401, ""));                     // 新凭据被拒：没有 ok 结算，也就不会发起新的用量请求
  h.clock.t = LNOW + 6 * MIN;
  h.client.refresh();
  await flush();
  assert.equal(h.client.view().status, "auth_failed");
  assert.notEqual(st.fingerprint, fp);
  assert.equal(h.hist.length, 1);
  d.resolve(fakeRes(200, fixBody()));
  await flush();
  assert.equal(st.hist, null, "the old credential's usage must not be attached to the new identity");
  h.client.dispose();
});

test("usage history: a failed or malformed response leaves the sampled curve; a later success upgrades it in place and pushes an update", async () => {
  let pushes = 0;
  const h = makeClient({ onUpdate: () => { pushes++; } });
  h.client.noteProvider(BIGMODEL);
  const bad = [() => fakeRes(500, "boom"), () => fakeRes(200, "<html>"),
    () => fakeRes(200, JSON.stringify({ success: true, data: { x_time: ["2026-11-23 00:00"], tokensUsage: ["a", "b"] } }))];
  for (let i = 0; i < bad.length; i++) {
    h.respondHist(bad[i]);
    await settleAt(h, LNOW + 6 * MIN * i, 30, LRESET);
    const pts = h.client.view().forecast.pts;
    assert.deepEqual(pts[pts.length - 1], [6120 + 6 * i, 30], "sample-only curve while the endpoint fails");
    assert.equal(pts.length, i + 1);
  }
  assert.equal(h.client.view().status, "ok", "history failures never touch the quota state machine");
  const d = deferred();
  h.respondHist(() => d.promise);
  await settleAt(h, LNOW + 18 * MIN, 30, LRESET);        // 额度已结算，用量请求挂起：此刻仍是采样曲线
  assert.deepEqual(h.client.view().forecast.pts.slice(-1), [[6138, 30]]);
  assert.equal(h.client.view().forecast.pts.length, 4);
  const settled = pushes;
  d.resolve(fakeRes(200, fixBody()));
  await flush();                                          // 响应到达：原位换成逐日曲线并推送一次
  assert.deepEqual(h.client.view().forecast.pts, [[1440, 3], [2880, 9], [4320, 9], [5760, 18], [6138, 30]]);
  assert.equal(pushes, settled + 1);
  h.client.dispose();
});

test("usage history: a superseded in-flight request is aborted and its late response ignored", async () => {
  const h = makeClient();
  const d1 = deferred(), d2 = deferred();
  let n = 0;
  h.respondHist(() => (++n === 1 ? d1.promise : d2.promise));
  h.client.noteProvider(BIGMODEL);
  await settleAt(h, LNOW, 30, LRESET);                  // 请求 1 挂起
  await settleAt(h, LNOW + 6 * MIN, 30, LRESET);        // 请求 2 取代请求 1
  assert.equal(h.hist.length, 2);
  assert.equal(h.hist[0].init.signal.aborted, true);
  d2.resolve(fakeRes(200, fixBody()));
  await flush();
  assert.deepEqual(h.client.view().forecast.pts, [[1440, 3], [2880, 9], [4320, 9], [5760, 18], [6126, 30]]);
  d1.resolve(fakeRes(200, usageBody([hourLabel(L0)], [9e9])));   // 迟到：不得覆盖
  await flush();
  assert.deepEqual(h.client.view().forecast.pts, [[1440, 3], [2880, 9], [4320, 9], [5760, 18], [6126, 30]]);
  h.client.dispose();
});

test("usage history: a response that lands after dispose is dropped and leaves no timer behind", async () => {
  let pushes = 0;
  const d = deferred();
  const h = makeClient({ onUpdate: () => { pushes++; } });
  h.respondHist(() => d.promise);
  h.client.noteProvider(BIGMODEL);
  await settleAt(h, LNOW, 30, LRESET);                  // 额度已结算，用量请求挂起
  assert.deepEqual(h.client.view().forecast.pts, [[6120, 30]]);
  h.client.dispose();
  const st = h.client._states.get("bigmodel");
  assert.equal(st.histKill, null);
  assert.equal(h.hist[0].init.signal.aborted, true);
  const before = pushes;
  d.resolve(fakeRes(200, fixBody()));
  await flush();
  assert.equal(pushes, before);
  assert.equal(st.hist, null);
  assert.deepEqual(h.client.view().forecast.pts, [[6120, 30]]);
});

test("usage history: once the limit is reached the sampled curve stays — the hit time comes from samples, not day boundaries", async () => {
  const h = makeClient();
  h.client.noteProvider(BIGMODEL);
  h.respondHist(() => fakeRes(200, fixBody()));
  await settleAt(h, LNOW - HOUR, 60, LRESET);
  await settleAt(h, LNOW + 6 * MIN, 100, LRESET);
  const f = h.client.view().forecast;
  assert.deepEqual(f.pts, [[6060, 60], [6126, 100]]);
  assert.equal(f.hit, LNOW + 6 * MIN);
  h.client.dispose();
});

test("usage history: only the forecast adapter pulls usage; the pull follows the quota URL override and stops when it is unparseable", async () => {
  const zai = makeClient();
  zai.client.noteProvider("account:zai-pro");
  await settleAt(zai, LNOW, 30, LRESET);
  assert.equal(zai.client.view().status, "ok");
  assert.equal(zai.hist.length, 0);
  zai.client.dispose();

  const h = makeClient({ env: { ZCODE_BIGMODEL_USAGE_QUOTA_URL: "http://127.0.0.1:65535/quota" } });
  h.client.noteProvider(BIGMODEL);
  await settleAt(h, LNOW, 30, LRESET);
  assert.equal(h.hist.length, 1);
  assert.equal(h.hist[0].url.indexOf("http://127.0.0.1:65535/api/monitor/usage/model-usage?startTime="), 0);
  h.client.dispose();

  const off = makeClient({ env: { ZCODE_BIGMODEL_USAGE_QUOTA_URL: "not a url" } });
  off.client.noteProvider(BIGMODEL);
  await settleAt(off, LNOW, 30, LRESET);
  assert.equal(off.hist.length, 0);
  assert.deepEqual(off.client.view().forecast.pts, [[6120, 30]]);
  off.client.dispose();
});
