# -*- coding: utf-8 -*-
"""serve 快照缓存回归（v266 变更门控 + same_ok 协议；v267 补 UPDATE/DELETE 探测、
聚合短缓存清理与降级载荷不缓存）。

覆盖：相关表未变时回放上一份快照、model_usage 插入失效、请求行变化失效、
same_ok 只回 {"same":1}、远端 scopes 永不缓存、config mtime 失效、缓存上限、
连接重建清缓存、异常载荷不缓存、变更戳本身的行为。
"""
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("zusage_serve_cache_test", REPO / "zusage.py")
zusage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(zusage)

# 与 test_serve_conn_reuse 同款最小库（缓存戳只依赖这几张表的 rowid）
SCHEMA = """
create table session (id text primary key, title text, parent_id text, time_created integer,
  time_updated integer, time_title_updated integer,
  summary_additions integer, summary_deletions integer, summary_files integer);
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

ROW = ("r1", "s1", "turn", "main_turn", "", "account:test", "model-x", "completed",
       1_000_000, 1_013_661, 1_015_087, 15087, 13661, 10, 1074, 0, 0, 0, 1084, 0, 0, 0)


class ServeCacheTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.db = self.dir / "db.sqlite"
        self.cfg = self.dir / "config.json"
        self.cfg.write_text("{}", encoding="utf-8")
        self.make_db()
        self.conns = []
        real_connect = zusage.connect

        def counting_connect():
            con = real_connect()
            self.conns.append(con)
            return con

        for name, value in (("DB_PATH", self.db), ("CONFIG_PATH", self.cfg), ("_pricing", None),
                            ("_SERVE_MARKS_TTL_MS", 0)):
            patch = mock.patch.object(zusage, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(zusage, "connect", counting_connect)
        patch.start()
        self.addCleanup(patch.stop)
        zusage._AGG_CACHE.clear()
        zusage._PROJ_CACHE.clear()

    def make_db(self):
        con = sqlite3.connect(self.db)
        try:
            con.executescript(SCHEMA)
            con.execute("insert into session (id, title) values ('s1', 't')")
            con.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ROW)
            con.commit()
        finally:
            con.close()

    def add_usage_row(self, rid):
        writer = sqlite3.connect(self.db)
        try:
            row = list(ROW)
            row[0] = rid
            writer.execute("insert into model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
            writer.commit()
        finally:
            writer.close()

    def patch_snapshot(self, side_effect=None):
        calls = []

        def fake(force_sid, routes, serve_con=None):
            calls.append((force_sid, routes))
            if side_effect is not None:
                return side_effect(len(calls))
            return {"n": len(calls), "sids": force_sid}

        patch = mock.patch.object(zusage, "snapshot", side_effect=fake)
        patch.start()
        self.addCleanup(patch.stop)
        return calls

    def run_serve(self, lines):
        out = io.StringIO()
        stdin = io.StringIO("".join(lines))
        with mock.patch.object(zusage.sys, "stdin", stdin), mock.patch.object(zusage.sys, "stdout", out):
            zusage.serve()
        return [json.loads(x) for x in out.getvalue().splitlines()]

    # ---- 基本命中 ----

    def test_repeated_local_request_replays_snapshot(self):
        calls = self.patch_snapshot()
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertEqual(len(payloads), 2)
        self.assertEqual(payloads[0], payloads[1])
        self.assertEqual(len(calls), 1, "两请求应只算一次快照")
        self.assertEqual(len(self.conns), 1, "缓存命中复用同一连接")

    def test_same_ok_marker_only_on_hit(self):
        calls = self.patch_snapshot()
        req = '{"sids":[],"scopes":[],"same_ok":1}\n'
        payloads = self.run_serve([req, req, ""])
        self.assertEqual(len(calls), 1)
        self.assertEqual(payloads[0], {"n": 1, "sids": ""})
        self.assertEqual(payloads[1], {"same": 1})

    def test_legacy_request_without_same_ok_gets_full_payload(self):
        self.patch_snapshot()
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertNotIn("same", payloads[1], "旧泵不带 same_ok，必须回完整缓存包")

    # ---- 失效条件 ----

    def test_model_usage_insert_invalidates(self):
        def side(n):
            if n == 1:
                self.add_usage_row("r2")   # 宿主在请求完成时 INSERT
            return {"n": n}

        calls = self.patch_snapshot(side)
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertEqual([p["n"] for p in payloads], [1, 2])
        self.assertEqual(len(calls), 2)

    def test_request_line_change_invalidates(self):
        calls = self.patch_snapshot()
        self.run_serve(['{"sids":["s1"],"scopes":[]}\n', '{"sids":["s2"],"scopes":[]}\n', ""])
        self.assertEqual(len(calls), 2)

    def test_remote_scopes_never_cached(self):
        calls = self.patch_snapshot()
        req = '{"sids":[],"scopes":[{"sid":"sA","workspaceIdentity":"remote:ssh:h:22:u:/p"}],"same_ok":1}\n'
        payloads = self.run_serve([req, req, ""])
        self.assertEqual(len(calls), 2)
        self.assertTrue(all("same" not in p for p in payloads))

    def test_config_mtime_invalidates(self):
        def side(n):
            if n == 1:
                st = self.cfg.stat()
                os.utime(self.cfg, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
            return {"n": n}

        calls = self.patch_snapshot(side)
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertEqual(len(calls), 2)
        self.assertNotIn("same", payloads[1])

    def test_cache_max_age_forces_recompute(self):
        calls = self.patch_snapshot()
        with mock.patch.object(zusage, "_SERVE_CACHE_MAX_AGE", -1.0):
            self.run_serve(["\n", "\n", ""])
        self.assertEqual(len(calls), 2)

    def test_connection_rebuild_clears_cache(self):
        calls = self.patch_snapshot()
        with mock.patch.object(zusage, "_SERVE_IDLE_S", -1.0):
            self.run_serve(["\n", "\n", ""])
        self.assertEqual(len(calls), 2, "连接重建后不得回放旧连接上的缓存")
        self.assertEqual(len(self.conns), 2)

    def test_error_payload_not_cached(self):
        def side(n):
            if n == 1:
                raise RuntimeError("boom")
            return {"n": n}

        calls = self.patch_snapshot(side)
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertIn("error", payloads[0])
        self.assertNotIn("error", payloads[1])
        self.assertEqual(len(calls), 2)

    def test_degraded_payload_not_cached(self):
        """v267：带 local_error 的行级降级快照不缓存——回放会把瞬时读失败的零值行钉住。"""
        def side(n):
            return {"n": n, "local_error": "disk I/O error"} if n == 1 else {"n": n}

        self.patch_snapshot(side)
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertEqual([p["n"] for p in payloads], [1, 2])
        self.assertEqual(payloads[0].get("local_error"), "disk I/O error")

    def test_write_clears_aggregate_short_caches(self):
        """v267：变更戳变化导致重算时，先清 today/report/项目聚合短缓存，避免旧聚合被新戳钉住。"""
        flags = []

        def side(n):
            if n == 1:
                # 模拟首个快照填好的聚合短缓存，随后宿主落库
                zusage._AGG_CACHE[("today", 1)] = (0, (1,))
                zusage._PROJ_CACHE[("db", 1)] = (0, {})
                self.add_usage_row("r2")
            else:
                flags.append((("today", 1) in zusage._AGG_CACHE, ("db", 1) in zusage._PROJ_CACHE))
            return {"n": n}

        self.patch_snapshot(side)
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertEqual([p["n"] for p in payloads], [1, 2])
        self.assertEqual(flags, [(False, False)], "重算前必须清空聚合短缓存")

    def test_tool_status_change_keeps_aggregate_caches(self):
        """v267：聚合短缓存不依赖 tool_usage——工具起止只失效快照，不清 today/report/项目缓存。"""
        writer = sqlite3.connect(self.db)
        try:
            writer.execute("insert into tool_usage (session_id, tool_name, status, duration_ms) values ('s1','x','running',0)")
            writer.commit()
        finally:
            writer.close()
        flags = []

        def side(n):
            if n == 1:
                zusage._AGG_CACHE[("today", 1)] = (0, (1,))
                zusage._PROJ_CACHE[("db", 1)] = (0, {})
                w = sqlite3.connect(self.db)
                try:
                    w.execute("update tool_usage set status='completed' where tool_name='x'")
                    w.commit()
                finally:
                    w.close()
            else:
                flags.append((("today", 1) in zusage._AGG_CACHE, ("db", 1) in zusage._PROJ_CACHE))
            return {"n": n}

        self.patch_snapshot(side)
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertEqual([p["n"] for p in payloads], [1, 2], "工具状态变化仍须失效快照")
        self.assertEqual(flags, [(True, True)], "但不得清聚合短缓存")

    def test_hit_keeps_aggregate_short_caches(self):
        """未变更时命中快路径，不清聚合短缓存（清空只该发生在有写入的重算前）。"""
        def side(n):
            zusage._AGG_CACHE[("today", 1)] = (0, (1,))
            return {"n": n}

        self.patch_snapshot(side)
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertEqual([p["n"] for p in payloads], [1, 1])
        self.assertIn(("today", 1), zusage._AGG_CACHE)

    # ---- 变更戳本身 ----

    def test_change_token_tracks_rowids(self):
        con = sqlite3.connect(self.db)
        try:
            before = zusage._serve_change_token(con)
            con.execute("insert into tool_usage (session_id, tool_name, status, duration_ms) values ('s1','x','completed',1)")
            con.commit()
            after = zusage._serve_change_token(con)
        finally:
            con.close()
        self.assertIsNotNone(before)
        self.assertNotEqual(before, after)

    def test_change_token_tracks_tool_status_update_and_session_delete(self):
        """v267：同 rowid 的 status UPDATE 与 session 行 DELETE 都要改变变更戳。"""
        con = sqlite3.connect(self.db)
        try:
            con.execute("insert into tool_usage (session_id, tool_name, status, duration_ms) values ('s1','x','running',0)")
            con.commit()
            t1 = zusage._serve_change_token(con)
            con.execute("update tool_usage set status='completed' where tool_name='x'")
            con.commit()
            t2 = zusage._serve_change_token(con)
            con.execute("delete from session where id='s1'")
            con.commit()
            t3 = zusage._serve_change_token(con)
        finally:
            con.close()
        self.assertNotEqual(t1, t2, "工具完成是 UPDATE，max(rowid) 不变")
        self.assertNotEqual(t2, t3, "会话删除会改变行数")

    def test_tool_status_update_invalidates_serve_cache(self):
        writer = sqlite3.connect(self.db)
        try:
            writer.execute("insert into tool_usage (session_id, tool_name, status, duration_ms) values ('s1','x','running',0)")
            writer.commit()
        finally:
            writer.close()

        def side(n):
            if n == 1:
                w = sqlite3.connect(self.db)
                try:
                    w.execute("update tool_usage set status='completed' where tool_name='x'")
                    w.commit()
                finally:
                    w.close()
            return {"n": n}

        self.patch_snapshot(side)
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertEqual([p["n"] for p in payloads], [1, 2])

    def test_session_change_invalidates_serve_cache(self):
        # 宿主生成标题时 UPDATE title 并 bump time_title_updated（time_updated 在生成中每个 step
        # 都会变，v267 刻意不纳入变更戳，故这里只按标题专用列构造）
        def side(n):
            w = sqlite3.connect(self.db)
            try:
                if n == 1:
                    w.execute("update session set title='renamed', time_title_updated=42 where id='s1'")
                w.commit()
            finally:
                w.close()
            return {"n": n}

        self.patch_snapshot(side)
        payloads = self.run_serve(["\n", "\n", ""])
        self.assertEqual([p["n"] for p in payloads], [1, 2])

    def test_change_token_missing_table_is_none(self):
        con = sqlite3.connect(":memory:")
        try:
            self.assertIsNone(zusage._serve_change_token(con))
        finally:
            con.close()


if __name__ == "__main__":
    unittest.main()
