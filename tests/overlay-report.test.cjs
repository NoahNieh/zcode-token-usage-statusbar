const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v260 ⚙「用量报表」分区：整 IIFE 执行 + instances 接缝（overlay-quota-chip 同款夹具）。
 * v262 重设计：五档视图切换器（session|project|today|d7|d30）+ 单卡视图——断言
 * 分区导航注册、默认会话卡、范围汇总卡（totals/tps/命中率/费用门控/模型 tps 列）、
 * 缺 stats 判空、签名幂等、每日趋势随档、口径折叠块。面板 DOM 是桩（innerHTML 为
 * 字符串），按字符串断言。 */
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
    this.style.setProperty = (k, v) => { this.style[k] = v; };
    this.style.getPropertyValue = k => this.style[k] || '';
    this.listeners = new Map(); this.queries = new Map(); this.classes = new Set();
    this.classList = { contains: k => this.classes.has(k), add: k => this.classes.add(k), remove: k => this.classes.delete(k),
      toggle: (k, on) => { if (on) this.classes.add(k); else this.classes.delete(k); } };
    this.textContent = ''; this.innerHTML = ''; this._className = ''; this.isConnected = true;
  }
  set className(v) { this._className = String(v); this.classes.clear(); this._className.split(/\s+/).filter(Boolean).forEach(c => this.classes.add(c)); }
  get className() { return this._className; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const i = this.parentElement.children.indexOf(this);
    return this.parentElement.children[i + 1] || null;
  }
  setAttribute(k, v) { this.dataset[k] = String(v); }
  removeAttribute(k) { delete this.dataset[k]; }
  addEventListener(type, fn) { const a = this.listeners.get(type) || []; a.push(fn); this.listeners.set(type, a); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
  appendChild(el) { this.children.push(el); el.parentElement = this; el.isConnected = true; return el; }
  insertBefore(el, ref) {
    if (!ref || ref.parentElement !== this) return this.appendChild(el);
    if (el.parentElement) el.remove();
    const idx = this.children.indexOf(ref);
    this.children.splice(idx, 0, el); el.parentElement = this; el.isConnected = true; return el;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.parentElement = null; this.isConnected = false; }
  matches(sel) { return sel === '.zu-sr-only' && this.classList.contains('zu-sr-only'); }
  querySelector(k) {
    if (k.startsWith('.')) { const all = this.querySelectorAll(k); if (all.length) return all[0]; }
    if (k === '[data-testid="chat-context-usage-trigger"]') {
      for (const c of this.children) {
        if (c.dataset && c.dataset['data-testid'] === 'chat-context-usage-trigger') return c;
        const hit = c.querySelector && c.querySelector(k);
        if (hit) return hit;
      }
      return null;
    }
    if (!this.queries.has(k)) this.queries.set(k, new Element());
    return this.queries.get(k);
  }
  querySelectorAll(sel) {
    if (sel === '[data-testid="v4-model-config"]') {
      return this.children.filter(e => e.getAttribute('data-testid') === 'v4-model-config').concat(
        ...this.children.map(e => e.querySelectorAll(sel)));
    }
    if (sel === 'circle') return this.children.filter(e => e.tagName === 'CIRCLE').concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    if (sel === '.zu-sr-only') return this.children.filter(e => e.classList.contains('zu-sr-only')).concat(
      ...this.children.filter(e => e.querySelectorAll).map(e => e.querySelectorAll(sel)));
    return [];
  }
  contains(el) { return el === this || this.children.some(e => e.contains(el)); }
  closest() { return null; }
  hasAttribute(k) { return k === 'data-pane-id' ? !!this.pid : k === 'data-session-id' ? !!this.sid : Object.prototype.hasOwnProperty.call(this.dataset, k); }
  getAttribute(k) { return k === 'data-pane-id' ? (this.pid || null) : k === 'data-session-id' ? (this.sid || null) : (this.dataset[k] !== undefined ? this.dataset[k] : null); }
  getBoundingClientRect() { return { top: 600, bottom: 650, left: 20, right: 520, width: 500, height: 50 }; }
}

function harness({ prefs = {} } = {}) {
  const window = new Element(), body = new Element('body'), root = new Element('html');
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  window.__zusagePluginState = {};
  let panes = [];
  const document = new Element();
  Object.assign(document, { body, documentElement: root, createElement: tag => new Element(tag),
    getElementById: id => body.children.find(e => e.id === id),
    querySelectorAll: selector => selector.startsWith('textarea,') ? panes : [],
    elementFromPoint: () => panes[0] || body });
  const timers = new Map(), frames = new Map(), observers = []; let id = 0;
  const lsStore = new Map(Object.entries(prefs));
  const sandbox = vm.createContext({ window, document, console, innerHeight: 800, innerWidth: 1000,
    location: { href: 'file:///fixture' },
    localStorage: { getItem: k => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => { lsStore.set(String(k), String(v)); } },
    getComputedStyle: () => ({ borderTopWidth: '1px', backgroundColor: 'black', opacity: '1', display: 'block', visibility: 'visible' }),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, interval: false }); return id; },
    clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearInterval: n => timers.delete(n),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: n => frames.delete(n),
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
      observe(target) { this.target = target; this.connected = true; }
      disconnect() { this.connected = false; }
    },
  });
  const executable = source.replace(/\}\)\(\);\s*$/, 'window.quotaTest = { instances: function() { return instances; }, state: function() { return state; } };})();');
  function inject() { window.__zusageOverlay = false; vm.runInContext(executable, sandbox); }
  function tick() { for (const t of [...timers.values()]) if (t.interval && (t.ms === 600 || t.ms === 500)) t.fn(); }
  function boot() { for (const [n, t] of [...timers]) if (!t.interval && t.ms === 0) { timers.delete(n); t.fn(); } }
  function buildComposer(pid, sid) {
    const card = body.appendChild(new Element());
    const row = card.appendChild(new Element());
    row.className = 'group/toolbar flex items-end gap-3';
    const wrap = row.appendChild(new Element('span'));
    wrap.className = 'inline-flex shrink-0';
    const btn = wrap.appendChild(new Element('button'));
    btn.setAttribute('data-testid', 'chat-context-usage-trigger');
    btn.setAttribute('aria-label', '上下文已用 63,400 / 总量 200,000');
    const editor = card.appendChild(new Element('textarea'));
    editor.pid = pid; editor.sid = sid;
    panes.push(editor);
    return { card, row, wrap, btn, editor };
  }
  function payload(stats) {
    const out = { remote_evidence: false, today: {}, not_local: [],
      recent: [{ sid: 'sid_main', workspace_identity: '', ctx: 63400, context_window: 200000, last_at: 1, ctx_exc: 0,
        last: { provider_id: 'account:bigmodel-individual-coding-plan', model: 'GLM-5.3-Flash' } }] };
    if (stats !== undefined) out.stats = stats;
    return out;
  }
  const panel = () => body.children.find(e => e.classList && e.classList.contains && e.classList.contains('zu-settings'));
  const repBody = () => panel().querySelector('.zu-rep-body');
  function clickTab(view) {
    const tab = new Element('button');
    tab.setAttribute('data-rep-view', view);
    const evt = { target: { closest: sel => (sel === '.zu-rep-tab' ? tab : null) } };
    for (const fn of panel().listeners.get('click') || []) fn(evt);
    return tab;
  }
  return { window, body, inject, boot, tick, buildComposer, payload, panel, repBody, clickTab, state: () => window.quotaTest.state() };
}

const NOW = 1_799_000_000_000;
const ROW = over => ({ model: 'GLM-5.3', provider: 'account:test', requests: 10,
  input: 100, output: 200, total: 300, cache_read: 72, tps: 64.4, rated_output: 200, unrated_output: 0, cost_usd: 0.5, rates: {} });
const TOTALS = over => ({ requests: 10, input: 100, output: 200, total: 300, cache_read: 80,
  cache_write: 5, reasoning: 30, rated_output: 200, unrated_output: 0, gen_ms: 4000, tps: 50.5,
  started: NOW - 600000, last_at: NOW });
const STATS = () => ({
  models: { today: [ROW()], d7: [Object.assign(ROW(), { model: 'GLM-5.3-7d', total: 700, tps: 71.2 })], d30: [ROW()] },
  days: Array.from({ length: 30 }, (_, i) => ({ d: '11-%02d Sat'.replace('%02d', String(i + 1).padStart(2, '0')), requests: i === 29 ? 10 : 0, input: 0, output: 0, total: i === 29 ? 300 : 0 })),
  sessions: [{ sid: 's1', title: '会话甲', directory: 'D:/proj', requests: 10, total: 300, last_at: NOW }],
  totals: { today: TOTALS(), d7: Object.assign(TOTALS(), { requests: 70, total: 2100, tps: 55.5 }),
            d30: Object.assign(TOTALS(), { requests: 300, total: 9000, tps: 60.1 }) },
});

function sessRow() {
  return {
    title: '主会话', input: 10000, output: 2000, reasoning: 300, cache_read: 8000, cache_write: 100,
    total: 12000, turns: 2, requests: 4, tool_calls: 1, retries: 0, started: NOW - 60000, last_at: NOW,
    avg_tps: 85.3,
    models: [{ model: 'GLM-5.3', requests: 3, total: 1000, tps: 123.4, input: 900, cache_read: 600 },
             { model: 'claude-opus-5-5', requests: 1, total: 2000, input: 2000, cache_read: 0 }],
    project: { sessions: 2, turns: 5, requests: 9, input: 50000, output: 6000, reasoning: 400,
      cache_read: 40000, cache_write: 200, total: 56000, started: NOW - 120000, last_at: NOW,
      name: 'my-proj', avg_tps: 79.2, models: [{ model: 'GLM-5.3', requests: 8, total: 3000, tps: 250, input: 2500, cache_read: 1500 }] },
  };
}
const setup = h => { h.buildComposer('workspace-main', 'sid_main'); h.inject(); h.boot(); h.tick(); };

test('report section is registered in the nav with the five-view switcher and caliber details', () => {
  const h = harness(); setup(h);
  const panelHtml = h.panel().innerHTML;
  assert.ok(panelHtml.includes('data-sec="report"'), 'report section in panel');
  assert.ok(panelHtml.includes('用量报表'), 'zh label');
  for (const v of ['session', 'project', 'today', 'd7', 'd30']) {
    assert.ok(panelHtml.includes('data-rep-view="' + v + '"'), 'tab ' + v);
  }
  assert.ok(panelHtml.includes('zu-rep-cal'), 'caliber details block');
  assert.ok(panelHtml.includes('统计口径'), 'caliber summary');
});

test('default view renders the session card with avg row and per-model tps column', () => {
  const h = harness(); setup(h);
  const p = h.payload(STATS());
  Object.assign(p.recent[0], sessRow());
  h.window.__zusageUpdate(p);
  const html = h.repBody().innerHTML;
  assert.ok(html.includes('会话累计'), 'session card head');
  assert.ok(html.includes('主会话'), 'session name');
  assert.ok(html.includes('平均速率'), 'avg row label');
  assert.ok(html.includes('85.3'), 'session avg tps');
  assert.ok(html.includes('<th>平均速率 t/s</th>'), 'model tps column');
  assert.ok(html.includes('123.4'), 'per-model tps');
  assert.ok(html.includes('缓存命中率 80%'), 'hit pct');
  assert.ok(html.includes('<th>缓存命中</th>'), 'model cache hit column');
  assert.ok(html.includes('66.67%'), 'per-model cache hit (600/900)');
  assert.ok(html.includes('<td>0%</td>'), 'zero-hit model shows 0%');
  assert.ok(!html.includes('每日趋势'), 'no daily trend in session view');
});

test('cache hit column is gated: models without input fields keep the old table', () => {
  const h = harness(); setup(h);
  const s = STATS();
  s.models.today = [{ model: 'GLM-5.3', provider: 'account:test', requests: 10,
    output: 200, total: 300, tps: 64.4, rated_output: 200, unrated_output: 0, cost_usd: 0.5, rates: {} }];   // 旧快照形态：无 input/cache_read
  h.window.__zusageUpdate(h.payload(s));
  h.clickTab('today');
  const html = h.repBody().innerHTML;
  assert.ok(!html.includes('<th>缓存命中</th>'), 'no cache hit column without input fields');
  assert.ok(html.includes('<th>平均速率 t/s</th>'), 'tps column unaffected');
  assert.ok(html.includes('zu-stat-table'), 'table still rendered');
});

test('project view: card renders when the picked row carries project, neutral note otherwise', () => {
  const h = harness(); setup(h);
  const p = h.payload(STATS());
  Object.assign(p.recent[0], sessRow());
  h.window.__zusageUpdate(p);
  h.clickTab('project');
  let html = h.repBody().innerHTML;
  assert.ok(html.includes('项目累计'), 'project card head');
  assert.ok(html.includes('my-proj'), 'project name');
  assert.ok(html.includes('79.2'), 'project avg tps');
  assert.ok(html.includes('250'), 'project model tps');
  assert.ok(html.includes('<th>缓存命中</th>'), 'project model cache hit column');
  assert.ok(html.includes('60%'), 'project model cache hit (1500/2500)');
  // 行无 project 字段（远端/轻量行）：中性提示，不渲染空卡
  const p2 = h.payload(STATS());
  h.window.__zusageUpdate(p2);
  h.clickTab('project');
  assert.ok(h.repBody().innerHTML.includes('项目累计不可用'), 'neutral note without project');
});

test('today view renders the totals card: tps, hit rate, cost KPI, model table; no trend', () => {
  const h = harness(); setup(h);
  h.window.__zusageUpdate(h.payload(STATS()));
  h.clickTab('today');
  const html = h.repBody().innerHTML;
  assert.ok(html.includes('今日合计'), 'today card head');
  assert.ok(html.includes('50.5'), 'weighted tps from totals');
  assert.ok(html.includes('缓存命中率 80%'), 'hit rate from totals.cache_read');
  assert.ok(html.includes('$0.50'), 'cost KPI (Σ model cost, default $ without fx)');
  assert.ok(html.includes('64.4'), 'per-model tps in table');
  assert.ok(html.includes('<th>缓存命中</th>'), 'range model cache hit column');
  assert.ok(html.includes('72%'), 'per-model cache hit from stats.models');
  assert.ok(html.includes('300'), 'totals tokens');
  assert.ok(html.includes('最近会话'), 'recent sessions appended');
  assert.ok(!html.includes('每日趋势'), 'no trend in today view');
});

test('d7/d30 views show the daily trend with range totals', () => {
  const h = harness(); setup(h);
  h.window.__zusageUpdate(h.payload(STATS()));
  h.clickTab('d7');
  assert.ok(h.repBody().innerHTML.includes('每日趋势'), 'trend in d7');
  assert.ok(h.repBody().innerHTML.includes('55.5'), 'd7 totals tps');
  h.clickTab('d30');
  assert.ok(h.repBody().innerHTML.includes('每日趋势'), 'trend in d30');
  assert.ok(h.repBody().innerHTML.includes('60.1'), 'd30 totals tps');
});

test('missing stats: session/project views still render, range views show the neutral note', () => {
  const h = harness(); setup(h);
  const p = h.payload(undefined);
  p.recent[0].title = '仅会话卡';
  p.recent[0].total = 500;
  h.window.__zusageUpdate(p);
  assert.ok(h.repBody().innerHTML.includes('仅会话卡'), 'session card without stats');
  h.clickTab('today');
  assert.ok(h.repBody().innerHTML.includes('统计数据不可用'), 'range note');
  assert.ok(!h.repBody().innerHTML.includes('zu-stat-table'), 'no table');
});

test('cost column follows the estimated-cost toggle in the range card', () => {
  const h = harness(); setup(h);
  h.window.__zusageUpdate(h.payload(STATS()));
  h.clickTab('today');
  assert.ok(h.repBody().innerHTML.includes('预估费用'), 'cost KPI on by default');
  h.state().cost = 0;
  const changed = STATS();
  changed.totals.today.tps = 12.5;   // 触发签名变化
  h.window.__zusageUpdate(h.payload(changed));
  const html = h.repBody().innerHTML;
  assert.ok(!html.includes('预估费用'), 'cost KPI gone');
  assert.ok(!html.includes('$0.50'), 'cost cell gone');
  assert.ok(html.includes('12.5'), 'card still rendered');
});

test('signature idempotence: identical payload does not rebuild, changed payload does', () => {
  const h = harness(); setup(h);
  const p = h.payload(STATS());
  Object.assign(p.recent[0], sessRow());
  h.window.__zusageUpdate(p);
  const box = h.repBody();
  let writes = 0, current = box.innerHTML;
  Object.defineProperty(box, 'innerHTML', { configurable: true,
    get() { return current; }, set(v) { writes++; current = v; } });
  const p2 = h.payload(STATS());
  Object.assign(p2.recent[0], sessRow());
  h.window.__zusageUpdate(p2);
  assert.equal(writes, 0, 'same content → signature hit, no rebuild');
  const p3 = h.payload(STATS());
  Object.assign(p3.recent[0], sessRow());
  p3.recent[0].total = 9800;   // <1万：fmt 原样渲染，避开万单位换算
  h.window.__zusageUpdate(p3);
  assert.equal(writes, 1, 'changed data → one rebuild');
  assert.ok(current.includes('9800'), 'new total rendered');
});

test('empty range: totals zeros render a zero card with the no-request note, no fake table', () => {
  const h = harness(); setup(h);
  const empty = STATS();
  empty.models.today = [];
  empty.totals.today = Object.assign(TOTALS(), { requests: 0, input: 0, output: 0, total: 0, tps: 0, cache_read: 0 });
  h.window.__zusageUpdate(h.payload(empty));
  h.clickTab('today');
  const html = h.repBody().innerHTML;
  assert.ok(html.includes('该范围暂无请求'), 'no-request note');
  assert.ok(!html.includes('zu-stat-table'), 'no model table');
  assert.ok(html.includes('今日合计'), 'card head still rendered');
});
