const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// v268：子代理运行期速率估算（v97 槽位桥、v179 acquire 降级、主格「子代理运行中 · 估 X t/s」）
// 已随主会话生成中估算一并移除。本文件保留仍有效的 zuBarSpeedView 工具态用例（Agent 行只出
// 状态词、工具组、Skill 名），并锁定替代槽位桥的「运行中子代理登记」（subLiveTick/subLiveDetach）。
// zuToolVerb 以恒等 stub 注入——文案长度另由 ZU_TOOL_VERBS 提取断言覆盖。
const NOW = 11000;

function extractSpeedView(source, lang, zuSkillName) {
  const start = source.indexOf('  /* v127 tok/s 十档色');
  const end = source.indexOf('  /* 思考态动效图标', start);
  assert.ok(start >= 0 && end > start, '提取失败: zuBarSpeedView');
  return vm.runInNewContext(source.slice(start, end) + '\nzuBarSpeedView;', {
    L: (zh, en) => (lang === 'en' ? en : zh),
    zuToolVerb: (name) => name,
    zuSkillName: zuSkillName || ((t) => (t || '').slice(0, 24)),
    zuSkillBaseName: zuSkillName || ((t) => (t || '')),   // v235：zuBarSpeedView Skill 分支取全名再自行截断
    Date: { now: () => NOW },
  });
}

/* v158：真实 zuSkillName 提取（与 overlay 同源切片，v235 起连带其依赖的
 * zuSkillBaseName 全名函数），供 Skill 分支用例注入 */
function extractSkillName(source) {
  const start = source.indexOf('  function zuSkillBaseName(');
  const nameStart = source.indexOf('  function zuSkillName(');
  const end = source.indexOf('\n  }', nameStart) + 4;   // 含 zuSkillName 收尾 '\n  }'
  assert.ok(start >= 0 && nameStart > start && end > nameStart, '提取失败: zuSkillName/zuSkillBaseName');
  return vm.runInNewContext(source.slice(start, end) + '\nzuSkillName;', {});
}

const source = fs.readFileSync(path.join(__dirname, '..', 'overlay.js'), 'utf8');

for (const lang of ['zh', 'en']) {
  const speedView = extractSpeedView(source, lang);
  const agentTool = { name: 'Agent', startedAt: 1000, childSessionId: 'sess_subagent_a' };
  test(`${lang}: subagent-row form (no startedAt, no subSum) shows verb only`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Agent', startedAt: null, childSessionId: 'sess_subagent_a' },
      characterRate: null, observedMs: 0 });
    assert.equal(view.text, 'Agent');
  });

  // v268：Agent 工具运行期不再有子代理「估 X t/s」合计——第三个参数即使传了旧形状的
  // subSum 也被忽略，只出状态词 + 耗时。
  test(`${lang}: Agent tool shows verb + elapsed only (no sub-agent estimate, v268)`, () => {
    const legacy = { rate: 45.16, at: NOW - 500, count: 3 };
    const view = speedView({ complete: false, runningTool: agentTool, observedMs: 0 }, legacy);
    assert.equal(view.text, 'Agent 10.0s');
    assert.equal(view.phase, 'tool');
    assert.equal(view.cls, 'dim');
    assert.equal(view.kind, 'tool');
    assert.equal(view.speedValue, undefined);
    assert.equal(speedView({ complete: false, runningTool: agentTool, observedMs: 0 }, null, legacy).text, 'Agent 10.0s');
  });

  test(`${lang}: non-agent tools are unaffected by a legacy third argument`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Read', startedAt: 1000 }, observedMs: 0 },
      null, { rate: 45.16, at: NOW - 100, count: 1 });
    assert.equal(view.text, 'Read 10.0s');
  });
  // v187 补回 v181 工具组状态词：运行行落在 ≥2 连续同类组尾时状态词跟随组标签
  // （数据由 turn-stats runningGroupOf 提供），计时锚定组首行 startedAt。
  test(`${lang}: running group tail overrides the per-tool verb, timing anchored to the group head`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Read', startedAt: 10000 },
      runningGroup: { kind: 'explore', startedAt: 8000 }, characterRate: null, observedMs: 0 });
    assert.equal(view.text, lang === 'en' ? 'Explore·executing 3.0s' : '查阅·执行中 3.0s');
    assert.equal(view.phase, 'tool');
    assert.equal(view.cls, 'dim');
  });

  test(`${lang}: terminal group label and per-group startedAt anchoring`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Bash', startedAt: 10900 },
      runningGroup: { kind: 'terminal', startedAt: 10000 }, characterRate: null, observedMs: 0 });
    assert.equal(view.text, lang === 'en' ? 'Terminal·executing 1.0s' : '终端·执行中 1.0s');
  });

  test(`${lang}: group without startedAt falls back to the running row's startedAt`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Read', startedAt: 10000 },
      runningGroup: { kind: 'explore', startedAt: null }, characterRate: null, observedMs: 0 });
    assert.equal(view.text, lang === 'en' ? 'Explore·executing 1.0s' : '查阅·执行中 1.0s');
  });

  test(`${lang}: absent runningGroup keeps the legacy per-tool verb (old tracker compat)`, () => {
    const view = speedView({ complete: false, runningTool: { name: 'Read', startedAt: 10000 }, characterRate: null, observedMs: 0 });
    assert.equal(view.text, 'Read 1.0s');
  });
}

/* ---------- v158：Skill 运行期「技能名·执行中」 ---------- */
test('skill tool shows the extracted skill name with executing suffix (zh/en)', () => {
  const sk = extractSkillName(source);
  for (const lang of ['zh', 'en']) {
    const view = extractSpeedView(source, lang, sk);
    const v = view({ complete: false, runningTool: { name: 'Skill', startedAt: NOW - 400,
      inputText: '{"name":"查阅","args":{}}' }, characterRate: null, observedMs: 0, startedAt: 1000 });
    assert.equal(v.text, lang === 'en' ? '查阅·executing 0.4s' : '查阅·执行中 0.4s');
    assert.equal(v.phase, 'tool');
  }
});
test('skill without a parsable name keeps the generic verb; long names ellipsize', () => {
  const view = extractSpeedView(source, 'zh', extractSkillName(source));
  const noName = view({ complete: false, runningTool: { name: 'Skill', startedAt: NOW - 400,
    inputText: '{"args":{}}' }, characterRate: null, observedMs: 0, startedAt: 1000 });
  assert.equal(noName.text, 'Skill 0.4s');   // zuToolVerb 恒等桩：真机为「运行技能中 0.4s」
  const long = view({ complete: false, runningTool: { name: 'Skill', startedAt: NOW - 400,
    inputText: '{"name":"' + 'x'.repeat(40) + '"}' }, characterRate: null, observedMs: 0, startedAt: 1000 });
  assert.ok(long.text.startsWith('x'.repeat(24) + '…·执行中'), long.text.slice(0, 40));
});
test('zuSkillName extraction: JSON field, regex fallback, control-char rejection', () => {
  const fn = extractSkillName(source);
  assert.equal(fn('{"name":"查阅"}'), '查阅');
  assert.equal(fn('not json {"name" : "zcode-review"} trailing'), 'zcode-review');
  assert.equal(fn('{"name":"' + 'y'.repeat(30) + '"}'), 'y'.repeat(24) + '…');
  assert.equal(fn('{"name":"a\\u0000b"}'), '');
  assert.equal(fn(''), '');
  assert.equal(fn('{"args":{}}'), '');
});

/* ---------- v268：运行中子代理登记（替代 v97 槽位速率桥） ---------- */
function extractSubLive() {
  const start = source.indexOf('    /* ---------- 运行中子代理登记');
  const end = source.indexOf('    /* ---------- 子代理行内速率 chip', start);
  assert.ok(start >= 0 && end > start, '提取失败: subLive');
  return vm.runInNewContext(source.slice(start, end) + '\n({ subLive, subLiveTick, subLiveDetach, MAX_SUB_SLOTS });', {});
}
function row(id, sid) { return { childSessionId: sid, rowId: id }; }

test('subLiveTick: registers exactly the running sub-agents and converges when they finish', () => {
  const api = extractSubLive();
  api.subLiveTick([row(1, 'sess_subagent_a'), row(2, 'sess_subagent_b')]);
  assert.deepEqual(Object.keys(api.subLive.sids).sort(), ['sess_subagent_a', 'sess_subagent_b']);
  api.subLiveTick([row(1, 'sess_subagent_a')]);
  assert.deepEqual(Object.keys(api.subLive.sids), ['sess_subagent_a']);   // 结束的即移出
  api.subLiveTick([]);
  assert.equal(Object.keys(api.subLive.sids).length, 0);   // VM 上下文内的对象，按键集比较
  api.subLiveTick([row(1, 'sess_subagent_a')]);
  api.subLiveTick(null);                                                 // 主轮完成/无桥 → 视同空集
  assert.equal(Object.keys(api.subLive.sids).length, 0);   // VM 上下文内的对象，按键集比较
  assert.deepEqual(api.subLive, api.subLive);   // 对象引用稳定（多实例闭包共享同一声明）
});

test('subLiveTick: keeps the newest 8 (rowId descending) and drops rows without childSessionId', () => {
  const api = extractSubLive();
  assert.equal(api.MAX_SUB_SLOTS, 8);
  const rows = [];
  for (let i = 1; i <= 12; i++) rows.push(row(i, 'sess_subagent_' + i));   // turn-stats 按 rowId 升序给出
  rows.push(row(13, null), row(14, undefined), row(15, ''));
  api.subLiveTick(rows);
  const sids = Object.keys(api.subLive.sids);
  assert.equal(sids.length, 8);
  for (let i = 5; i <= 12; i++) assert.ok(sids.includes('sess_subagent_' + i), '缺最新派发 ' + i);
  assert.equal(sids.includes('sess_subagent_4'), false);
  // 重复 sid 只登记一次
  api.subLiveTick([row(1, 'sess_subagent_a'), row(2, 'sess_subagent_a'), row(3, 'sess_subagent_b')]);
  assert.deepEqual(Object.keys(api.subLive.sids).sort(), ['sess_subagent_a', 'sess_subagent_b']);
});

test('subLiveDetach: clears the registry (main bridge release / generation change)', () => {
  const api = extractSubLive();
  api.subLiveTick([row(1, 'sess_subagent_a')]);
  api.subLiveDetach();
  assert.equal(Object.keys(api.subLive.sids).length, 0);   // VM 上下文内的对象，按键集比较
  api.subLiveDetach();   // 幂等
  assert.equal(Object.keys(api.subLive.sids).length, 0);   // VM 上下文内的对象，按键集比较
});

test('v268 source contract: no sub-agent store subscription or character sampling remains', () => {
  // 不再为子代理 acquire/订阅会话 store，也不再有逐槽位速率状态
  // （VERSION 行的注释是代际变更史，会提到这些旧名字——按行剔除后再查）
  const code = source.split('\n').filter(l => !l.includes('var VERSION = ')).join('\n');
  for (const gone of ['zuAcquireSubStore', 'SUBRATE_DIAG', 'subRateTickPanel', 'subRateSlotText',
    'subTryBindSlot', 'charsPerToken', 'DEFAULT_CHARS_PER_TOKEN', 'kind: "subagent"', 'zu-sl-estdim']) {
    assert.equal(code.includes(gone), false, 'overlay.js 仍残留 ' + gone);
  }
  // 子代理浮层：未入库的运行中子代理仍进导航并计数，但不带速率
  assert.ok(source.includes('for (var k in subLive.sids) sids.push(k);'), '面板导航未读运行中登记');
  assert.ok(source.includes("'<span class=\"zu-spnav-live\">' + ttEsc(L(\"运行中\", \"running\"))"), '导航运行中标签缺失');
  assert.ok(source.includes('meta.push(L("运行中", "Running"));'), '任务页运行中标记缺失');
  // 主桥释放时登记一并清空
  assert.ok(source.includes('subLiveDetach();   // 主桥释放'), 'bridgeDetach 未清空登记');
  // tracker：不再逐行数字符，但仍给出 runningSubagents
  const ts = fs.readFileSync(path.join(__dirname, '..', 'turn-stats.js'), 'utf8');
  assert.doesNotMatch(ts, /Array\.from\(text\)/);
  for (const gone of ['characterRate', 'totalCharacters', 'turn.samples']) assert.equal(ts.includes(gone), false, 'turn-stats.js 仍残留 ' + gone);
  assert.ok(ts.includes('runningSubagents.push({ childSessionId: row.childSessionId })'));
  // 插件副本同步
  const copy = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'zcode-token-usage-statusbar', 'overlay.js'), 'utf8');
  assert.equal(copy, source, '插件副本与根 overlay.js 不一致');
});
