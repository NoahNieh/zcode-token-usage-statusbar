const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

/* v260 ⚙「用量报表」分区：整 IIFE 执行 + instances 接缝（overlay-quota-chip 同款夹具）。
 * 断言：分区导航注册、stats 缺失判空不渲染、模型表内容（tps/费用门控）、签名幂等、
 * 范围 tab 切换重填、空范围占位。面板 DOM 是桩（innerHTML 为字符串），按字符串断言。 */
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
  function clickTab(range) {
    const tab = new Element('button');
    tab.setAttribute('data-rep-range', range);
    const evt = { target: { closest: sel => (sel === '.zu-rep-tab' ? tab : null) } };
    for (const fn of panel().listeners.get('click') || []) fn(evt);
    return tab;
  }
  return { window, body, inject, boot, tick, buildComposer, payload, panel, repBody, clickTab, state: () => window.quotaTest.state() };
}

const NOW = 1_799_000_000_000;
const ROW = over => ({ model: 'GLM-5.3', provider: 'account:test', requests: 10,
  input: 100, output: 200, total: 300, tps: 64.4, rated_output: 200, unrated_output: 0, cost_usd: 0.5, rates: {} });
const STATS = () => ({
  models: { today: [ROW()], d7: [Object.assign(ROW(), { model: 'GLM-5.3-7d', total: 700, tps: 71.2 })], d30: [ROW()] },
  days: Array.from({ length: 30 }, (_, i) => ({ d: '11-%02d Sat'.replace('%02d', String(i + 1).padStart(2, '0')), requests: i === 29 ? 10 : 0, input: 0, output: 0, total: i === 29 ? 300 : 0 })),
  sessions: [{ sid: 's1', title: '会话甲', directory: 'D:/proj', requests: 10, total: 300, last_at: NOW }],
});

test('report section is registered in the nav and renders model rows with tps and gated cost', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  assert.ok(h.panel().innerHTML.includes('data-sec="report"'), 'report section in panel');
  assert.ok(h.panel().innerHTML.includes('用量报表'), 'zh label');
  h.window.__zusageUpdate(h.payload(STATS()));
  const html = h.repBody().innerHTML;
  assert.ok(html.includes('GLM-5.3'), 'model name');
  assert.ok(html.includes('64.4'), 'weighted tps');
  assert.ok(html.includes('account:test'), 'provider dim label');
  assert.ok(html.includes('$0.50'), 'cost rendered (state.cost defaults on, no fx → $)');
  assert.ok(html.includes('每日趋势'), 'daily trend head');
  assert.ok(html.includes('会话甲'), 'session title');
  assert.ok(html.includes('300'), 'session total');
});

test('missing stats field renders a neutral note and no table (judge-empty discipline)', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload(undefined));
  const html = h.repBody().innerHTML;
  assert.ok(html.includes('统计数据不可用'), 'neutral note');
  assert.ok(!html.includes('zu-stat-table'), 'no table');
  assert.ok(!html.includes('GLM-5.3'), 'no model rows');
});

test('signature idempotence: identical payload does not rebuild, changed payload does', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload(STATS()));
  const box = h.repBody();
  let writes = 0, current = box.innerHTML;
  Object.defineProperty(box, 'innerHTML', { configurable: true,
    get() { return current; }, set(v) { writes++; current = v; } });
  h.window.__zusageUpdate(h.payload(STATS()));
  assert.equal(writes, 0, 'same stats → signature hit, no rebuild');
  const changed = STATS();
  changed.models.today[0].tps = 66.6;
  h.window.__zusageUpdate(h.payload(changed));
  assert.equal(writes, 1, 'changed stats → one rebuild');
  assert.ok(box.innerHTML.includes('66.6'), 'new tps rendered');
});

test('range tab click switches state.repRange and refills the body without rebuilding the panel', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload(STATS()));
  assert.ok(!h.repBody().innerHTML.includes('GLM-5.3-7d'), 'd7 model hidden in today range');
  h.clickTab('d7');
  assert.equal(h.state().repRange, 'd7', 'memory-only range state');
  assert.ok(h.repBody().innerHTML.includes('GLM-5.3-7d'), 'd7 model rendered after switch');
  assert.ok(!h.repBody().innerHTML.includes('>64.4<'), 'today tps gone');
});

test('cost column follows the estimated-cost toggle', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  h.window.__zusageUpdate(h.payload(STATS()));
  assert.ok(h.repBody().innerHTML.includes('预估费用'), 'cost header on by default');
  h.state().cost = 0;
  const changed = STATS();
  changed.models.today[0].tps = 12.5;   // 触发签名变化
  h.window.__zusageUpdate(h.payload(changed));
  const html = h.repBody().innerHTML;
  assert.ok(!html.includes('预估费用'), 'cost header gone');
  assert.ok(!html.includes('$0.50'), 'cost cell gone');
  assert.ok(html.includes('12.5'), 'row still rendered');
});

test('empty range shows the placeholder row instead of an empty table', () => {
  const h = harness();
  h.buildComposer('workspace-main', 'sid_main');
  h.inject(); h.boot(); h.tick();
  const empty = STATS();
  empty.models.today = [];
  h.window.__zusageUpdate(h.payload(empty));
  assert.ok(h.repBody().innerHTML.includes('该范围暂无请求'), 'placeholder row');
});
