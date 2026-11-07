const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');
const start = source.indexOf('    function positionSubPop() {');
const end = source.indexOf('    var subRateTimer = 0;', start);
assert.ok(start >= 0 && end > start, 'positionSubPop slice found');
const positionSource = source.slice(start, end);

/* v217：统一浮层定位——优先入口上方 12px，左右夹紧 12px；入口 rect 全零回退条锚；
 * 入口断连即关（无法确认归属）。 */
function position({ entryLeft = 800, entryWidth = 80, entryTop = 600, entryH = 20,
  panelWidth = 820, panelHeight = 500, viewportWidth = 1200, viewportHeight = 800,
  barLeft = 400, barTop = 600, entry = 'live', theme = 'default' } = {}) {
  const style = {};
  const rects = {
    entry: { left: entryLeft, width: entryWidth, top: entryTop, height: entryH },
    bar: { left: barLeft, width: 100, top: barTop, height: 20 },
  };
  const entryEl = entry === 'live' ? { isConnected: true, getBoundingClientRect: () => rects.entry }
    : entry === 'gone' ? { isConnected: false, getBoundingClientRect: () => rects.entry }
    : null;
  const context = {
    window: { innerWidth: viewportWidth, innerHeight: viewportHeight },
    subPopOpen: () => true,
    subPopEntry: entryEl,
    subPopClose: (r, cause) => { context.closed = cause; },
    subPanel: { offsetWidth: panelWidth, offsetHeight: panelHeight, style },
    bar: { getBoundingClientRect: () => rects.bar },
    state: { theme },
  };
  vm.runInNewContext(positionSource + '\npositionSubPop();', context);
  return { style, context };
}

test('popover centers above the entry and clamps to the left edge', () => {
  const { style } = position();
  assert.equal(style.left, '368px');   // 中心 840 − 410 = 430 → 钳右缘 1200−820−12
  assert.equal(style.top, '88px');     // 600 − 500 − 12
});

test('popover stays inside the viewport edges (12px)', () => {
  const { style } = position({ entryLeft: 1100 });
  assert.equal(style.left, '368px');   // 1200 − 820 − 12
  const l = position({ entryLeft: 10 });
  assert.equal(l.style.left, '12px');
});

test('popover flips below the entry when the space above is insufficient', () => {
  const { style } = position({ entryTop: 300 });   // 300 − 512 < 12 → 下方
  assert.equal(style.top, '288px');   // 332 + 500 > 788 → 钳底边 800−500−12
});

test('zero-rect entry falls back to the bar anchor; a detached entry closes the popover', () => {
  const fb = position({ entry: 'zero' });
  assert.equal(fb.style.left, '40px');   // bar 中心 450 − 410 = 40，未触边
  assert.equal(fb.style.top, '88px');
  const g = position({ entry: 'gone' });
  assert.equal(g.context.closed, 'entry-gone');
});

/* v217：buildSubPop 签名幂等——同数据重复推送不重建（保持滚动/焦点/选择），数据真变才重建 */
{
  const s0 = source.indexOf('    function subPopItems(sub) {');
  const s1 = source.indexOf('    function positionSubPop() {', s0);
  assert.ok(s0 >= 0 && s1 > s0, 'buildSubPop slice found');
  const buildSource = source.slice(s0, s1);   // 从 subPopItems 起：状态变量（subPopSel/sig/mode）由 ctx 注入

  function makePanel() {
    const panel = { children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
    Object.defineProperty(panel, 'innerHTML', {
      get() { return ''; },
      set(v) { panel.children.length = 0; panel.__html = v; },   // 对齐真 DOM：赋值即清子节点
      configurable: true,
    });
    panel.querySelector = () => null;
    panel.querySelectorAll = () => [];
    return panel;
  }
  function runBuild(panel, sub, sel, over) {
    const ctx = {
      subPopSel: sel || '', subPopMode: 'pinned', subPopSig: panel.__zuSig || '',
      subPanel: panel, subRate: { slots: {} }, state: { cost: 1 },
      pickedSid: 'sid_main', subPopSess: 'sid_main',
      L: (a) => a, ttEsc: (a) => String(a), escAttr: (a) => String(a),
      fmt: () => '1', countFmt: () => '1', fmtMoney: () => '¥1', fmtTime: () => '12:00', fmtStartS: () => '2026-01-01 00:00:00',
      tpsBand: () => null, FXQ_ICON: '<svg class="tip-fxq"></svg>',
      fxqIcon: (models, scope) => '<svg class="tip-fxq" data-mcount="' + (models ? models.length : 0) + '" data-mscope="' + scope + '"></svg>',   // v248：KPI 问号随卡携带模型上下文（实例闭包函数，切片外桩）
      subPopIco: () => '<svg></svg>',
      subRateSlotText: () => 'est', JSON,
      ...(over || {}),
    };
    ctx.subPopSel = (panel.__zuSel = sel !== undefined ? sel : (panel.__zuSel || ''));
    ctx.sub = sub;
    vm.runInNewContext(buildSource + '\nbuildSubPop(sub);', ctx);
    panel.__zuSig = ctx.subPopSig;
    return ctx;
  }

  test('unified popover is not rebuilt while open when the pushed data is unchanged', () => {
    const sub = { total: 100, active: false, requests: 3, cost_usd: 0.5, models: [],
      list: [{ task: 'probe', title: 't', agent: 'zcode-gen', sid: 'sess_subagent_abcd1234',
        input: 1, output: 2, cache_read: 0, reasoning: 0, cache_write: 0, requests: 1, tps_avg: 10, last: 123 }] };
    const panel = makePanel();
    runBuild(panel, sub, '');
    assert.ok(panel.__html && panel.__html.includes('zu-spnav'), 'first build renders shell');
    const marker = { marker: true };
    panel.children.push(marker);
    runBuild(panel, sub, '');
    assert.ok(panel.children.includes(marker), 'same data → DOM untouched (sig early-return)');
    runBuild(panel, Object.assign({}, sub, { total: 200 }), '');
    assert.ok(!panel.children.includes(marker), 'changed data → rebuilt');
    assert.ok(panel.__html.includes('zu-spnav'), 'rebuilt popover renders shell');
  });

  test('unified popover renders summary KPIs, cost and model table from real fields', () => {
    const sub = { total: 100, active: false, requests: 3, cost_usd: 0.5, rate_avg: 90,
      input: 60, output: 30, cache_read: 40, models: [
        { model: 'glm-x', total: 100, requests: 3, cost_usd: 0.5 }] };
    const panel = makePanel();
    runBuild(panel, sub, '');
    const html = panel.__html;
    assert.ok(html.includes('zu-sp-kpis3'), 'primary KPI band');
    assert.ok(html.includes('预估费用'), 'cost KPI present');
    assert.ok(html.includes('预估费用<svg class="tip-fxq" data-mcount="1" data-mscope="子代理累计"'), 'v248 KPI ? icon carries card model context');
    assert.ok(html.includes('zu-sp-models'), 'model table present');
    assert.ok(html.includes('tip-fxq" data-model="glm-x"'), 'per-model ? icon carries data-model');
    assert.ok(!html.includes('查看子代理明细'), 'old CTA removed');
    assert.ok(!html.includes('Enter'), 'no Enter keycap');
  });

  test('v246 summary KPI sub-lines carry hit rate / incl-thinking / cache-write', () => {
    const sub = { total: 100, active: false, requests: 3, cost_usd: 0.5, rate_avg: 90,
      input: 60, output: 30, cache_read: 40, cache_write: 5, reasoning: 6, models: [] };
    const panel = makePanel();
    runBuild(panel, sub, '');
    const html = panel.__html;
    assert.ok(html.includes('缓存命中率'), '输入行副行=命中率（回退 token 尾注即红）');
    assert.ok(html.includes('67%'), '命中率 40/60=67% 进副行');
    assert.ok(html.includes('含思考'), '输出行副行=含思考');
    assert.ok(!/<span class="u">(?:token|次|req)<\/span>/.test(html), 'KPI 第三参单位（token/次）已退役');
  });

  test('v246 detail view folds the average rate into the KPI band with an inline t/s unit', () => {
    const sub = { total: 100, active: false, requests: 3, cost_usd: 0.5, models: [],
      list: [{ task: 'probe', title: 't', agent: 'zcode-gen', sid: 'sess_subagent_abcd1234',
        input: 60, output: 30, cache_read: 40, cache_write: 5, reasoning: 6, requests: 1, tps_avg: 88, last: 123 }] };
    const panel = makePanel();
    runBuild(panel, sub, 'sess_subagent_abcd1234', { tpsBand: () => ({ cls: 'tps-fast', zh: '快', en: 'fast' }) });
    const html = panel.__html;
    assert.ok(/tps-fast[^<]*<\/span><small>t\/s<\/small>/.test(html), '平均速率档色值内联 t/s 单位');
    assert.equal((html.match(/平均速率/g) || []).length, 1, '明细页速率仅 KPI 一处（独立速率行已删）');
  });

  /* 工作流派发子会话（sess_dwf-*）并入子智能体面板：导航/详情加 zu-sp-wf badge，
   * 汇总页加「其中工作流」小计行（只聚合 dwf 条目，无 dwf 条目整行省略）。 */
  const mkItem = (sid, total, requests) => ({
    sid, task: '', title: sid.startsWith('sess_dwf') ? 'wf run' : 'probe', agent: '',
    total, requests, input: 1, output: 2, cache_read: 0, reasoning: 0, cache_write: 0, tps_avg: 0, last: 123,
  });
  const navSegOf = (html, sid) => {
    const at = html.indexOf('data-sid="' + sid + '"');
    assert.ok(at > -1, 'nav has ' + sid);
    const next = html.indexOf('<button', at);
    return html.slice(at, next > -1 ? next : html.length);
  };

  test('workflow dispatch entries carry nav badges and drive the workflow subtotal', () => {
    const sub = { total: 350, active: false, requests: 5, cost_usd: 0.5, models: [],
      list: [mkItem('sess_subagent_abcd1234', 100, 1),
             mkItem('sess_dwf-dwfrun-a', 200, 3),
             mkItem('sess_dwf-dwfrun-b', 50, 1)] };
    const panel = makePanel();
    runBuild(panel, sub, '', { fmt: n => String(n), countFmt: n => String(n) });
    const html = panel.__html;
    assert.match(html, /<div class="zu-sp-rate">其中工作流<b>250<\/b> · 4 次请求<\/div>/,
      '小计只聚合 dwf 条目（Task 的 100 不入）');
    assert.ok(navSegOf(html, 'sess_dwf-dwfrun-a').includes('zu-sp-wf'), 'dwf 导航条目带 badge');
    assert.ok(navSegOf(html, 'sess_dwf-dwfrun-b').includes('zu-sp-wf'), 'dwf 导航条目带 badge');
    assert.ok(!navSegOf(html, 'sess_subagent_abcd1234').includes('zu-sp-wf'), 'Task 条目不带 badge');
    assert.equal((html.match(/zu-sp-wf/g) || []).length, 2, '汇总页本体无 badge，仅导航两枚');
  });

  test('workflow detail view carries the badge in the panel head', () => {
    const sub = { total: 10, active: false, requests: 1, cost_usd: 0.5, models: [],
      list: [mkItem('sess_dwf-dwfrun-x', 10, 1)] };
    const panel = makePanel();
    runBuild(panel, sub, 'sess_dwf-dwfrun-x');
    const html = panel.__html;
    const head = html.slice(html.indexOf('zu-spview-head'), html.indexOf('zu-sp-kpis3'));
    assert.ok(head.includes('zu-sp-wf'), '详情页头带工作流 badge');
    assert.ok(head.includes('工作流'));
  });

  test('task subagent detail view has no workflow badge or subtotal', () => {
    const sub = { total: 10, active: false, requests: 1, cost_usd: 0.5, models: [],
      list: [{ sid: 'sess_subagent_abcd1234', task: 'probe', title: 't', agent: 'zcode-gen',
        total: 10, requests: 1, input: 1, output: 2, cache_read: 0, reasoning: 0,
        cache_write: 0, tps_avg: 0, last: 123 }] };
    const panel = makePanel();
    runBuild(panel, sub, 'sess_subagent_abcd1234');
    const html = panel.__html;
    assert.ok(!html.includes('zu-sp-wf'), 'Task 详情无 badge');
    assert.ok(!html.includes('其中工作流'), '无 dwf 条目 → 小计行不出现');
  });

  test('summary omits the workflow subtotal line when no dwf entries exist', () => {
    const sub = { total: 100, active: false, requests: 3, cost_usd: 0.5, models: [],
      list: [{ sid: 'sess_subagent_abcd1234', task: 'probe', title: 't', agent: 'zcode-gen',
        total: 100, requests: 3, input: 1, output: 2, cache_read: 0, reasoning: 0,
        cache_write: 0, tps_avg: 0, last: 123 }] };
    const panel = makePanel();
    runBuild(panel, sub, '');
    const html = panel.__html;
    assert.ok(!html.includes('其中工作流'), '无 dwf 条目 → 整行省略');
    assert.ok(!html.includes('zu-sp-wf'));
  });
}
