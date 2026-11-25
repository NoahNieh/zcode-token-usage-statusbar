const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// v176 子代理行内速率 chip：把泵快照 sub.list 的 tps_avg（已完成段真实平均速率）投到
// 宿主 v4 Agent 工具行（testid 前缀 v4-subagent-open-side-pane- + childSessionId）。
// v268：原「运行中槽位估算 → 估 X t/s」一态随字符增量估算整体移除——运行中尚无已完成段
// 的子代理不显示 chip，出现已完成段后直接显示真实平均速率。
// 夹具：源码切片 + 专用 DOM 桩（前缀选择器/子树类查询/父子链），渲染函数无状态对账的
// 幂等/串号/摘除/pane 隔离/浅色结构，以及 tooltip 构建器与源码契约。

const NOW = 1730000000000;

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this._cls = ''; this.classes = new Set();
    this.attrs = {}; this.textContent = ''; this.innerHTML = '';
    this.parentElement = null; this.isConnected = true;
  }
  get className() { return this._cls; }
  set className(v) { this._cls = String(v); this.classes = new Set(this._cls.split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  appendChild(c) { c.parentElement = this; this.children.push(c); c.isConnected = true; return c; }
  insertBefore(c, ref) {
    if (!ref || ref.parentElement !== this) return this.appendChild(c);
    const i = this.children.indexOf(ref);
    this.children.splice(i, 0, c); c.parentElement = this; c.isConnected = true; return c;
  }
  remove() {
    if (this.parentElement) {
      const a = this.parentElement.children, i = a.indexOf(this);
      if (i >= 0) a.splice(i, 1);
    }
    this.parentElement = null; this.isConnected = false;
  }
  contains(el) { return el === this || this.children.some(c => c.contains(el)); }
  get nextSibling() {
    if (!this.parentElement) return null;
    const a = this.parentElement.children, i = a.indexOf(this);
    return a[i + 1] || null;
  }
  get parentNode() { return this.parentElement; }
  querySelectorAll(sel) {
    const m = /^\[data-testid\^="(.+)"\]$/.exec(sel);
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const out = [];
    const walk = n => {
      for (const c of n.children) {
        const t = c.attrs['data-testid'];
        if (m ? (typeof t === 'string' && t.startsWith(m[1]))
          : (cls && c.classes.has(cls))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r[0] || null; }
}

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), utf());
function utf() { return 'utf8'; }

/* 真实 TPS_BANDS + tpsBand（与条面同源切片），档位类断言不做本地复制 */
function extractTpsBand() {
  const s = source.indexOf('  var TPS_BANDS = [');
  const e = source.indexOf('  /* tooltip 档位行文本', s);
  assert.ok(s >= 0 && e > s, '提取失败: TPS_BANDS/tpsBand');
  return vm.runInNewContext('(function(){' + source.slice(s, e) + '\nreturn tpsBand;})();', {});
}

/* 渲染切片：SUBROW_TID_PREFIX 起（subRowPaneRoot/subRowTipHTML/renderSubAgentRows）。
 * 闭包自由变量全部经沙箱全局注入，测试经 feed() 改写快照数据驱动。 */
function extractRender(lang) {
  const s = source.indexOf('    var SUBROW_TID_PREFIX = "v4-subagent-open-side-pane-";');
  const e = source.indexOf('    function sideHandleValid(handle) {', s);
  assert.ok(s >= 0 && e > s, '提取失败: 行内 chip 渲染切片');
  const ctx = vm.createContext({
    L: (zh, en) => (lang === 'en' ? en : zh),
    tpsBand: extractTpsBand(),
    ttEsc: x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ttRow: (k, v) => '<div class="rt-row"><b>' + k + '</b><span>' + v + '</span></div>',
    fmt: n => String(Math.round(n)),
    fmtStart: () => '2026-10-31 10:00',
    fmtStartS: () => '2026-10-31 10:00:05',
    Date: { now: () => NOW },
    document: {
      documentElement: { classList: { contains: () => true } },   // 深色主题（浅色结构另有源码契约）
      createElement: tag => new El(tag),
    },
    inactive: () => false,
    composer: null, wantedEl: null,
    lastSub: null,
    subTipFor: null,
    showSubTip: () => {}, hideSubTip: () => {},
    state: { show: { subRate: 1 } },   // v178 ⚙ 开关（测试直接改 ctx.state.show.subRate 驱动）
    console,
  });
  const fn = vm.runInContext(
    '(function(){' + source.slice(s, e) +
    '\nreturn { render: renderSubAgentRows, tip: subRowTipHTML, root: subRowPaneRoot };})();', ctx);
  return { ctx, fn };
}

/* 行夹具：v4 Agent 行 = trigger(testid+title) > [icon, kind, type, .tool-summary-content] */
function makeRow(csid, title) {
  const row = new El('div');
  row.setAttribute('data-testid', 'v4-subagent-open-side-pane-' + csid);
  if (title !== undefined) row.setAttribute('title', title);
  const content = new El('div');
  content.className = 'tool-summary-content min-w-0 flex';
  const desc = new El('span');
  content.appendChild(desc);
  row.appendChild(new El('span'));       // icon
  row.appendChild(new El('span'));       // kind label
  row.appendChild(new El('span'));       // type
  row.appendChild(content);
  return row;
}
function makePane(csid) {
  const root = new El();
  root.setAttribute('data-session-id', 'sid_main');
  const composer = new El('textarea');
  root.appendChild(composer);
  const row = makeRow(csid, 'Review 精简模式线');
  root.appendChild(row);
  return { root, composer, row, content: row.querySelector('.tool-summary-content') };
}
const chipOf = row => row.querySelector('.zu-subrate');
/* 快照数据：sub.list 里该子代理的已完成段平均速率（0 = 尚无已完成段） */
function feed(ctx, csid, tpsAvg, extra) {
  ctx.lastSub = { list: [Object.assign({ sid: csid, tps_avg: tpsAvg }, extra || {})] };
}

for (const lang of ['zh', 'en']) {

  test(`${lang}: running sub-agent shows no chip until a completed segment lands, then the real average (v268)`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    fn.render();                                   // 快照里还没有这个子代理（刚派发）
    assert.equal(chipOf(p.row), null, '未入库不显示');
    feed(ctx, 'sess_subagent_a', 0);               // 已有条目但尚无已完成段
    fn.render();
    assert.equal(chipOf(p.row), null, '运行中不估算、不出 chip');
    feed(ctx, 'sess_subagent_a', 45.16);
    fn.render();
    const chip = chipOf(p.row);
    assert.ok(chip, 'chip mounted');
    assert.equal(p.row.children.indexOf(chip), p.row.children.indexOf(p.content) + 1, '紧跟能摘行之后');
    assert.equal(chip.className, 'zu-subrate', '深色主题 chip 本体无 zu-light');
    assert.match(chip.innerHTML, /class="warm"/);
    assert.ok(chip.innerHTML.includes('>45.2 t/s<'), '只有数值+单位，无「估」前缀');
    assert.equal(chip.getAttribute('data-zusage-csid'), 'sess_subagent_a');
    assert.equal(chip.__zuT.mode, 'real');
    assert.equal(chip.__zuT.rate, '45.2');
    assert.equal(chip.__zuT.title, 'Review 精简模式线');
    assert.equal(typeof chip.__zuT.buildTip, 'function');
  });

  test(`${lang}: render is idempotent and reuses the same chip node across passes`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    feed(ctx, 'sess_subagent_a', 152);
    fn.render();
    const chip = chipOf(p.row);
    fn.render(); fn.render();
    assert.equal(chipOf(p.row), chip, '同节点复用');
    assert.equal(p.row.querySelectorAll('.zu-subrate').length, 1);
    assert.match(chip.innerHTML, /class="zu-teal"/);
    // 速率更新 → 原地改字（同节点、同内层结构）
    feed(ctx, 'sess_subagent_a', 620);
    fn.render();
    assert.equal(chipOf(p.row), chip);
    assert.match(chip.innerHTML, /class="zu-violet"/);   // 500–800 档
    assert.ok(chip.innerHTML.includes('>620.0 t/s<'));
  });

  test(`${lang}: zero / negative / non-numeric tps_avg shows nothing`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    for (const bad of [0, -3, NaN, null, undefined, 'abc', {}]) {
      feed(ctx, 'sess_subagent_a', bad);
      fn.render();
      assert.equal(chipOf(p.row), null, 'tps_avg=' + String(bad) + ' 不显示');
    }
    feed(ctx, 'sess_subagent_a', '88');               // 数值字符串归一为数值
    fn.render();
    assert.ok(chipOf(p.row).innerHTML.includes('>88.0 t/s<'));
  });

  test(`${lang}: chip follows the snapshot average on the same node; removal when data gone`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    feed(ctx, 'sess_subagent_a', 45.16, { task: 'Review 精简模式线', agent: 'general-purpose', output: 4350, requests: 6, last: NOW });
    fn.render();
    const chip = chipOf(p.row);
    assert.ok(chip);
    assert.equal(chip.__zuT.mode, 'real');
    assert.ok(chip.innerHTML.includes('>45.2 t/s<'), '真实值无估字头');
    ctx.lastSub = null;                                      // 数据消失 → 摘除
    fn.render();
    assert.equal(chipOf(p.row), null, '无数据摘除');
  });

  test(`${lang}: row testid reassigned to another subagent rewrites chip identity (串号)`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    feed(ctx, 'sess_subagent_b', 210);
    fn.render();
    assert.equal(chipOf(p.row), null, '旧 csid 无数据不挂');
    p.row.setAttribute('data-testid', 'v4-subagent-open-side-pane-sess_subagent_b');
    fn.render();
    const chip = chipOf(p.row);
    assert.ok(chip);
    assert.equal(chip.getAttribute('data-zusage-csid'), 'sess_subagent_b');
    assert.equal(chip.__zuT.csid, 'sess_subagent_b');
  });

  test(`${lang}: chip wiped by host rerender is recreated on next pass`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    feed(ctx, 'sess_subagent_a', 45.16);
    fn.render();
    chipOf(p.row).remove();                                  // 模拟 React 重挂连带丢弃
    fn.render();
    assert.ok(chipOf(p.row), '下一拍重建');
  });

  test(`${lang}: row without .tool-summary-content falls back to row end`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    p.content.remove();                                      // 空摘要行（宿主 hasSummaryContent=false 分支）
    ctx.composer = p.composer;
    feed(ctx, 'sess_subagent_a', 45.16);
    fn.render();
    const chip = chipOf(p.row);
    assert.ok(chip);
    assert.equal(chip.parentElement, p.row, '退回行末尾');
    assert.equal(p.row.children[p.row.children.length - 1], chip);
  });

  test(`${lang}: scan is scoped to this pane's session shell (split-view same session isolation)`, () => {
    const { ctx, fn } = extractRender(lang);
    const a = makePane('sess_subagent_a'), b = makePane('sess_subagent_a');
    feed(ctx, 'sess_subagent_a', 45.16);
    ctx.composer = a.composer;
    fn.render();
    assert.ok(chipOf(a.row), '本 pane 行有 chip');
    assert.equal(chipOf(b.row), null, '另一 pane 同会话行不受染指');
    ctx.composer = b.composer;
    fn.render();
    assert.ok(chipOf(b.row));
    assert.equal(b.row.querySelector('.zu-subrate').getAttribute('data-zusage-csid'), 'sess_subagent_a');
  });

  test(`${lang}: no [data-session-id] ancestor → render is a no-op (fail-closed root)`, () => {
    const { ctx, fn } = extractRender(lang);
    const root = new El();                                   // 无 data-session-id（桥未打/结构未知）
    const composer = new El('textarea');
    root.appendChild(composer);
    const row = makeRow('sess_subagent_a');
    root.appendChild(row);
    ctx.composer = composer;
    feed(ctx, 'sess_subagent_a', 45.16);
    fn.render();
    assert.equal(chipOf(row), null, '定位不到 pane 壳不写任何 DOM');
  });

  test(`${lang}: ⚙ switch off removes chips and suppresses hover tip; on rebuilds`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a');
    ctx.composer = p.composer;
    feed(ctx, 'sess_subagent_a', 45.16);
    fn.render();
    assert.ok(chipOf(p.row), '开启（默认）时挂载');
    let hidden = 0;
    ctx.hideSubTip = () => { hidden++; };
    ctx.subTipFor = chipOf(p.row);            // 模拟悬停中
    ctx.state.show.subRate = 0;               // ⚙ 关闭（data-k 通用 handler 写 state.show 后心跳对账）
    fn.render();
    assert.equal(chipOf(p.row), null, '关闭即摘除已有 chip');
    assert.ok(hidden >= 1, '收起本 pane 悬停浮层');
    fn.render();                              // 关闭态重复渲染不复活
    assert.equal(chipOf(p.row), null);
    ctx.state.show.subRate = 1;               // ⚙ 重开：心跳自然重建
    fn.render();
    assert.ok(chipOf(p.row), '重开重建');
  });

  test(`${lang}: switch off in one pane never hides another pane's open tooltip`, () => {
    const { ctx, fn } = extractRender(lang);
    const a = makePane('sess_subagent_a'), b = makePane('sess_subagent_a');
    feed(ctx, 'sess_subagent_a', 45.16);
    // 先在 b pane 渲染出 chip 并模拟悬停
    ctx.composer = b.composer;
    fn.render();
    const rowB = b.composer.parentElement.querySelectorAll('[data-testid^="v4-subagent-open-side-pane-"]')[0];
    const chipB = rowB.querySelector('.zu-subrate');
    assert.ok(chipB, 'b pane chip 已挂载');
    ctx.composer = a.composer;
    fn.render();
    let hidden = 0;
    ctx.hideSubTip = () => { hidden++; };
    ctx.subTipFor = chipB;
    ctx.state.show.subRate = 0;               // a pane 关闭
    fn.render();
    assert.ok(chipB.isConnected, 'b pane 的 chip 不受染指');
    assert.equal(hidden, 0, '别的 pane 的悬停浮层不被收起');
  });

  test(`${lang}: real tooltip — task name, agent, output/requests/last; hostile task escaped`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a', '');
    ctx.composer = p.composer;
    ctx.lastSub = { list: [{ sid: 'sess_subagent_a', tps_avg: 88.44, task: 'Review <script>alert(1)</script>', agent: 'general-purpose', input: 12000, output: 4350, requests: 6, started: NOW - 480000, last: NOW }] };
    fn.render();
    const html = fn.tip(chipOf(p.row).__zuT);
    assert.match(html, /Review &lt;script&gt;/, '动态名转义');
    assert.ok(!html.includes('<script>'));
    assert.match(html, /general-purpose/);
    assert.match(html, new RegExp('<b>' + (lang === 'en' ? 'Average rate' : '平均速率') + '</b><span>88.4 t/s'));
    assert.match(html, new RegExp('<b>' + (lang === 'en' ? 'Input' : '输入') + '</b><span>12000 token'), '输入行在输出行之上');
    const inputAt = html.indexOf((lang === 'en' ? 'Input' : '输入') + '</b>');
    const outputAt = html.indexOf((lang === 'en' ? 'Output' : '输出') + '</b>');
    assert.ok(inputAt > -1 && inputAt < outputAt, '输入行先于输出行');
    assert.match(html, /4350 token/);
    assert.match(html, new RegExp((lang === 'en' ? 'Requests' : '请求数') + '</b><span>6'));
    assert.match(html, new RegExp('<b>' + (lang === 'en' ? 'Time span' : '起始时间') + '</b><span>2026-10-31 10:00:05 - 2026-10-31 10:00:05'), '起始-结束范围行（到秒）');
    assert.ok(!html.includes('最后活动') && !html.includes('Last active'), '最后活动行已移除');
  });

  test(`${lang}: real tooltip without started (old snapshot) renders em-dash start side`, () => {
    const { ctx, fn } = extractRender(lang);
    const p = makePane('sess_subagent_a', '');
    ctx.composer = p.composer;
    ctx.lastSub = { list: [{ sid: 'sess_subagent_a', tps_avg: 88.44, task: 'T', agent: 'general-purpose', output: 4350, requests: 6, last: NOW }] };
    fn.render();
    const html = fn.tip(chipOf(p.row).__zuT);
    assert.match(html, new RegExp('<b>' + (lang === 'en' ? 'Time span' : '起始时间') + '</b><span>— - 2026-10-31 10:00:05'), '缺 started 只缺省起始侧');
    assert.ok(!html.includes('Input</b>') && !html.includes('输入</b>'), '缺 input 不渲染输入行');
  });
}

test('light theme structure: band class rides inner span, zu-light on chip body (descendant selectors)', () => {
  const s = source.indexOf('    var SUBROW_TID_PREFIX = "v4-subagent-open-side-pane-";');
  const e = source.indexOf('    function sideHandleValid(handle) {', s);
  const slice = source.slice(s, e);
  assert.match(slice, /var cls = "zu-subrate" \+ \(dark \? "" : " zu-light"\)/);
  assert.match(slice, /'<span class="' \+ bandCls \+ '">'/);
  // 浅色加深版是后代选择器，chip 本体携带 zu-light 时档位类必须在子节点上
  assert.match(source, /"\.zu-light \.ok\{color:#0f9d6c\}/);
});

test('source contracts: updateLive hook, scan cleanup, delegation listener, CSS rule, version', () => {
  assert.match(source, /renderSubAgentRows\(\);   \/\/ v176：Agent 行内速率 chip 对账/, 'updateLive 挂渲染通道');
  assert.match(source, /if \(subTipFor && !subTipFor\.isConnected\) hideSubTip\(\);/, 'scanRateLines detach 兜底收起');
  assert.ok(source.includes('e.target.closest(".zu-subrate")'), 'document 委托悬停（免逐 chip 监听）');
  assert.match(source, /"\.zu-subrate\{flex:0 0 auto;white-space:nowrap;cursor:help/, 'chip 样式入注入块');
  assert.match(source, /var VERSION = "v\d+"/);   // 版本行在位即可，具体号随提交递增（v259/v260 起不再逐版改钉，旧 v258 硬钉在 HEAD 上已红两个版本）   // v254 = 宿主顶部 48px [app-region:drag] 拖拽条穿透浮层，设置面板头部 ✕ 点击被窗口拖拽吞掉；.zusage-panel/.tip/.zu-mp-ov/.zu-compact-dlg/.zusage-exc 浮层根显式 no-drag（宿主自家浮层同款修法）；v253 = 本轮/今日合计 tooltip 模型明细改项目卡式四列表格（zu-pj-mhead+statTable，费用列随 state.cost 门控；本轮 rt-models 行式退役，精简摘要保留）+ 本轮 tooltip 删「速度＝Σ…未参与测速」口径行（unrated_output 字段照旧生产）；v252 = 模型拉取同步提供商侧配置（issue #236：零兄弟 api-key 供应商首拉写实最小骨架+有据元数据（contextWindow/inputFormat/档位/输出上限，稀疏个人规则 map 继承内置 apiType catch-all），档位按强度梯排序（宿主默认档=values 末项），Copilot capabilities 别名，api.json 档位目录（reasoning_options→effort 词表）缺证据时按需后台补缺（轻量索引落运行目录 24h stale-while-revalidate 跨重启复用，补拉中行内状态+脚注说明），套餐源接目录补缺，弹窗行「未获取配置」中性提示+脚注披露只增不覆盖）；v251 = 套餐额度显示口径开关（⚙「显示剩余额度」，zusage3.quotaRemain 缺省关=已用）：chip 面分段数字与 aria、tooltip 窗口行/Key 总额度行/其他源摘要行改按剩余%（100−已用，同一窗口池补数）打头，绝对值窗口行内已用/剩余明细互换顺序，档位色恒按已用原始值判定，余额/Key 剩余额度/团队/未配置形态不受影响）；v250 = 速度柱状图按轮聚合+悬停卡全格式时间与轮明细+柱间距收紧（zusage _speed_segments 按 turn_id 合并一次提问的全部请求：v=Σ有效输出÷Σ生成窗口，随段携带 m/i/o/n/c；悬停信息卡渲染 模型/Token 用量（含输入·输出拆分）/请求次数/预估费用 + yyyy-MM-dd HH:mm:ss，明细行数参与 CARD_H 校准，X 轴每标签恒带月日，柱宽 calc(20%+12px)=柱白精确收紧 20%，段→轮措辞；编号顺延避让已合入的 v249「点击激活简化」PR #224）；v248 = 预估费用说明气泡「当前模型」随卡携带模型上下文（上一会话已完成、已部署未提交，随本批补录入库）；  // v179/v180 review P1：调用侧形状锁——showSubTip 以数据包调 buildTip（v178 回归即红）
  assert.ok(source.includes('el.__zuT.buildTip(el.__zuT)'), 'tooltip 数据包调用约定');
  assert.ok(source.includes("runningSubagents.length - 1"), '截断从尾部取（最新派发优先）');
  // v268：不再为子代理 acquire/订阅会话 store
  assert.doesNotMatch(source, /zuAcquireSubStore|acquire\(out\)|charsPerToken|subRate\.slots/);
  // 委托 mouseout 不得把移入浮层当作离开（提示 180ms 延迟收起与 tpsTip 同款）
  assert.match(source, /subTip\.contains\(to\)/);
});

test('source contracts: ⚙ subRate switch (seed, panel row, render gate)', () => {
  assert.match(source, /subRate: 1 \},/, 'state.show 种子默认开');
  assert.match(source, /data-k="subRate"/, '⚙ 面板行（data-k 通用 handler 零接线）');
  assert.match(source, /if \(!state\.show\.subRate\) \{/, '渲染门控读开关');
  assert.match(source, /rootEl\.contains\(subTipFor\) \|\| !subTipFor\.isConnected/, '只收本 pane 浮层');
});
