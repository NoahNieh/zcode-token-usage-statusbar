# -*- coding: utf-8 -*-
"""⚙ 用量报表（快照可选字段 stats，v260）：zusage._report_stats 聚合口径。

口径：范围桶 today/d7/d30 按本地自然日闭区间（today=今日，d7=今日+前 6 天，
d30=今日+前 29 天）；tokens/次数含子代理（与今日合计同口径），速度仅 main_turn 行按
_row_gen_ms 窗口（200ms–1h）加权——与状态条会话均同源。改库后须重置 _COVERS_CACHE
（_provider_first_token_covers 60s TTL）与 _AGG_CACHE（跨测试泄漏）。

运行：python3 -B -m unittest discover -s tests -p 'test_statusbar_report.py'
"""
import importlib.util
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
PLUGIN = REPO / "plugins" / "zcode-token-usage-statusbar"
if str(PLUGIN) not in sys.path:
    sys.path.append(str(PLUGIN))   # token_rate 依赖同目录的 runtime_lock


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


zusage = load("statusbar_report_zusage", REPO / "zusage.py")

# 只建 _report_stats / recent_sessions / snapshot 实际读取的表与列（session 多 directory）
SCHEMA = """
create table session (id text primary key, title text, directory text, parent_id text,
  time_created integer, summary_additions integer, summary_deletions integer, summary_files integer);
create table model_usage (id text primary key, session_id text, turn_id text, query_source text,
  agent text, provider_id text, model_id text, status text, started_at integer, first_token_at integer,
  completed_at integer, duration_ms integer, time_to_first_token_ms integer, input_tokens integer,
  output_tokens integer, reasoning_tokens integer, cache_read_input_tokens integer,
  cache_creation_input_tokens integer, computed_total_tokens integer, tool_call_count integer,
  retry_count integer, context_exceeded integer);
create table turn_usage (session_id text, turn_id text, status text, model_request_count integer,
  model_retry_count integer, tool_call_count integer, tool_error_count integer, input_tokens integer,
  output_tokens integer, reasoning_tokens integer, cache_read_input_tokens integer,
  cache_creation_input_tokens integer, computed_total_tokens integer, duration_ms integer,
  time_to_first_token_ms integer);
create table tool_usage (session_id text, tool_name text, status text, duration_ms integer);
"""

BASE = zusage._epoch_ms(zusage._day_start())   # 今日本地零点（毫秒）
DAY = 86_400_000


class ReportFixture(unittest.TestCase):
    def setUp(self):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.row_factory = sqlite3.Row
        con.executescript(SCHEMA)
        self.con = con
        # covers/聚合缓存是模块级：跨测试必须重置（_provider_first_token_covers 60s TTL）
        zusage._COVERS_CACHE.update(ts=0.0, set=frozenset())
        zusage._AGG_CACHE.clear()

    def insert(self, *rows):
        for r in rows:
            self.con.execute(
                "insert into model_usage values (" + ",".join("?" * 22) + ")", r)

    def sess(self, sid, title="t", directory=""):
        self.con.execute(
            "insert into session (id, title, directory) values (?,?,?)", (sid, title, directory))

    @staticmethod
    def row(rid, model="GLM-5.3", prov="account:test", qs="main_turn", status="completed",
            started=0, completed=0, ft=None, out=100, inp=10, reasoning=0, sid="s"):
        """ft=None → 首字=完成前 1s（默认 1s 有效窗口）。"""
        ft = completed - 1000 if ft is None else ft
        return (rid, sid, "turn", qs, "", prov, model, status, started, ft, completed,
                completed - started, completed - ft, inp, out, reasoning, 0, 0,
                inp + out, 0, 0, 0)

    @staticmethod
    def at(days_ago, ms_into_day=12 * 3600 * 1000):
        """第 days_ago 天前的本地当日时刻（默认正午，避开日界歧义）。"""
        return BASE - days_ago * DAY + ms_into_day

    def today_models(self, **kw):
        return zusage._report_stats(self.con, kw.pop("covers", frozenset()))["models"]


class ReportStatsTests(ReportFixture):
    def test_merge_by_model_provider_dominance(self):
        """同模型经多 provider 聚合合并为一行；provider 取请求数最多者；total=in+out。"""
        self.insert(
            self.row("r1", completed=self.at(0), out=100, inp=10),
            self.row("r2", completed=self.at(0) + 1000, out=200, inp=20),
            self.row("r3", prov="relay:x", completed=self.at(0) + 2000, out=50, inp=5),
            self.row("r4", model="m2", completed=self.at(0) + 3000, out=400, inp=40))
        rows = self.today_models()["today"]
        self.assertEqual([m["model"] for m in rows], ["m2", "GLM-5.3"])   # total 降序
        m1 = rows[1]
        self.assertEqual((m1["requests"], m1["input"], m1["output"], m1["total"]), (3, 35, 350, 385))
        self.assertEqual(m1["provider"], "account:test")   # 2 次 > 1 次

    def test_tps_window_rule_follows_row_gen_ms(self):
        """covers provider 思考随首字流出→首字窗口；推理前置→started_at；无思考→首字窗口。"""
        base = self.at(0)
        # 无思考：400 tok / 4s = 100.0
        self.insert(self.row("r1", completed=base, started=base - 10_000,
                             ft=base - 4_000, out=400, reasoning=0))
        # provider 在 covers：思考 5000 但首字窗口已含 → 仍 4s 窗口，与 r1 合并 800/8s
        self.insert(self.row("r2", completed=base + 1000, started=base + 1000 - 10_000,
                             ft=base + 1000 - 4_000, out=400, reasoning=5_000))
        # 另一 provider 不在 covers：思考前置 → completed-started = 10s → 40.0
        # （独立模型避免与上两行按模型合并混窗口）
        self.insert(self.row("r3", model="gpt-x", prov="relay:x", completed=base + 2000,
                             started=base + 2000 - 10_000,
                             ft=base + 2000 - 4_000, out=400, reasoning=5_000))
        rows = self.today_models(covers={"account:test"})["today"]
        self.assertEqual(rows[0]["tps"], 100.0)   # r1/r2 合并：800/8s（covers 规则生效）
        self.assertEqual(rows[1]["tps"], 40.0)    # r3：推理前置窗口
        self.assertEqual(rows[1]["provider"], "relay:x")

    def test_invalid_segments_stay_out_of_denominator(self):
        """窗口 <200ms 或 >1h 的输出进 unrated，不稀释也不虚算 0 t/s。"""
        base = self.at(0)
        self.insert(
            self.row("ok", completed=base, started=base - 5_000, ft=base - 4_000, out=400),
            self.row("tiny", completed=base + 1000, started=base + 900, ft=base + 950, out=1000),
            self.row("huge", completed=base + 2000, started=base + 2000 - 2 * 3600_000,
                     ft=base + 2000 - 3600_000, out=500))
        rep = zusage._report_stats(self.con)
        m = rep["models"]["today"][0]
        self.assertEqual(m["tps"], 100.0)               # 只剩 400/4s
        self.assertEqual(m["rated_output"], 400)
        self.assertEqual(m["unrated_output"], 1500)     # tiny+huge 都不算分母

    def test_subagent_counts_tokens_not_speed(self):
        """子代理行计 tokens/次数，不进速度分子分母（unrated 也不计）。"""
        base = self.at(0)
        self.insert(
            self.row("main", completed=base, started=base - 2_000, ft=base - 1_000, out=200),
            self.row("sub", qs="subagent", completed=base + 1000,
                     started=base + 1000 - 3_000, ft=base + 1000 - 1_000, out=900))
        m = self.today_models()["today"][0]
        self.assertEqual((m["requests"], m["output"]), (2, 1100))
        self.assertEqual(m["rated_output"], 200)
        self.assertEqual(m["unrated_output"], 0)
        self.assertEqual(m["tps"], 200.0)               # 200/1s，900 不进任何速度口径

    def test_range_bucketing_natural_days(self):
        """today/d7/d30 逐层包含；30 天前的窗口外行整行排除；days 恒 30 行含空日。"""
        self.insert(
            self.row("r1", completed=self.at(0), out=100, inp=10),
            self.row("r2", completed=self.at(3), out=200, inp=20),
            self.row("r3", completed=self.at(8), out=400, inp=40),
            self.row("r4", completed=self.at(40), out=999, inp=99))
        rep = zusage._report_stats(self.con)
        by = rep["models"]
        self.assertEqual([m["model"] for m in by["today"]], ["GLM-5.3"])
        self.assertEqual([m["requests"] for m in by["d7"]], [2])      # r1+r2（3 天前在内，8 天前不在）
        self.assertEqual([m["requests"] for m in by["d30"]], [3])     # +r3；r4 在窗外
        self.assertEqual(len(rep["days"]), 30)
        self.assertEqual(rep["days"][-1]["requests"], 1)              # 末位=今日
        self.assertEqual(sum(1 for d in rep["days"] if d["requests"] == 0), 27)
        self.assertEqual(rep["days"][0]["requests"], 0)               # 29 天前：空日

    def test_today_closed_interval_boundary(self):
        """completed_at 恰在今日零点=今日（闭区间下界）；零点前 1ms=昨日（不进 today）。"""
        self.insert(
            self.row("edge", completed=BASE, out=100, inp=10),
            self.row("pre", completed=BASE - 1, out=200, inp=20))
        rep = zusage._report_stats(self.con)
        self.assertEqual(rep["days"][-1]["requests"], 1)     # edge
        self.assertEqual(rep["days"][-2]["requests"], 1)     # pre → 昨天
        today = rep["models"]["today"][0]
        self.assertEqual(today["output"], 100)

    def test_pricing_missing_keeps_tokens_omits_cost(self):
        """价表模块缺失（旧运行目录）：cost_usd/rates 省略，token/速度照常。"""
        self.insert(self.row("r1", completed=self.at(0), out=100, inp=10))
        with mock.patch.object(zusage, "_pricing", None):
            rep = zusage._report_stats(self.con)
        m = rep["models"]["today"][0]
        self.assertNotIn("cost_usd", m)
        self.assertNotIn("rates", m)
        self.assertEqual((m["total"], m["tps"]), (110, m["tps"]))
        for d in rep["days"]:
            self.assertNotIn("cost_usd", d)

    def test_pricing_present_attaches_cost_and_rates(self):
        self.insert(self.row("r1", completed=self.at(0), out=100, inp=10))
        pricing = mock.Mock()
        pricing.merge_model_costs.return_value = (1.25, {"GLM-5.3": 1.25})
        pricing.lookup_full.return_value = (
            {"input": 1.0, "output": 2.0, "cache_read": 0.1, "cache_write": 0.2}, "k", None)
        with mock.patch.object(zusage, "_pricing", pricing, create=True):
            rep = zusage._report_stats(self.con)
        m = rep["models"]["today"][0]
        self.assertEqual(m["cost_usd"], 1.25)
        self.assertEqual(m["rates"]["output"], 2.0)
        self.assertIn("cost_usd", rep["days"][-1])

    def test_sessions_filter_subsessions_and_limit(self):
        """recent_sessions 过滤子会话（sess_subagent 前缀），过滤后取最近 10 条。"""
        for i in range(12):
            sid = "main%02d" % i
            self.sess(sid, title="标题%d" % i, directory="D:/p%d" % i)
            self.insert(self.row("r%d" % i, sid=sid,
                                 completed=self.at(0) - i * 1000, out=10, inp=1))
        self.sess("sess_subagent_x", title="子")
        self.insert(self.row("sub1", sid="sess_subagent_x", completed=self.at(0) + 5000))
        rep = zusage._report_stats(self.con)
        sess = rep["sessions"]
        self.assertEqual(len(sess), 10)
        self.assertTrue(all(not s["sid"].startswith("sess_subagent") for s in sess))
        self.assertEqual(sess[0]["sid"], "main00")      # 按最后完成时间降序
        self.assertEqual(sess[0]["title"], "标题0")
        self.assertEqual(sess[0]["total"], 11)          # in+out


class ReportCachedAggTests(unittest.TestCase):
    def test_cached_agg_ttl_override(self):
        zusage._AGG_CACHE.clear()
        self.addCleanup(zusage._AGG_CACHE.clear)
        calls = []

        def fn():
            calls.append(1)
            return len(calls)

        k = ("report-test", 1)
        self.assertEqual(zusage._cached_agg(k, fn, ttl_ms=5000), 1)
        self.assertEqual(zusage._cached_agg(k, fn, ttl_ms=5000), 1)   # TTL 内命中
        self.assertEqual(calls, [1])


class ReportSnapshotTests(ReportFixture):
    def test_snapshot_includes_stats(self):
        """serve_con 注入 ：memory: 库：快照带 stats 且范围/日行/会话齐全。"""
        self.sess("s", title="主会话", directory="D:/proj")
        self.insert(self.row("r1", completed=self.at(0), started=self.at(0) - 2_000,
                             out=200, inp=20))
        snap = zusage.snapshot("s", serve_con=self.con)
        self.assertIn("stats", snap)
        stats = snap["stats"]
        self.assertEqual(stats["models"]["today"][0]["tps"], 200.0)
        self.assertEqual(len(stats["days"]), 30)
        self.assertEqual(stats["sessions"][0]["sid"], "s")

    def test_snapshot_stats_fail_soft(self):
        """聚合失败（缺表）省略 stats 字段，不拖垮整帧（today/session 照常返回）。"""
        self.con.executescript("drop table model_usage;")
        snap = zusage.snapshot("s", serve_con=self.con)
        self.assertNotIn("stats", snap)
        self.assertIn("session", snap)
        self.assertIn("today", snap)


if __name__ == "__main__":
    unittest.main()
