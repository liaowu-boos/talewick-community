"""Focused evidence/rendering checks; only synthetic in-memory inputs."""

from copy import deepcopy
import hashlib
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence import normalize_citation, normalize_issue, render_report


def source(text, source_id="draft", kind="draft"):
    return {"source_id": source_id, "kind": kind, "text": text,
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "path": f"/synthetic/{source_id}.txt"}


def issue(check_id="C03"):
    return {"id": "question-1", "check_id": check_id, "kind": "novel_question",
            "rule_source_ids": [check_id],
            "citations": [{"source_id": "draft", "quote": "甲已知道地点。"},
                          {"source_id": "draft", "quote": "甲此前从不知道地点。"}],
            "reasoning": "同一人物对同一事实的两处明确陈述可能矛盾。",
            "alternative_explanations": ["仍需核对回忆、谎言或失忆解释。"],
            "uncertainty": "定位成立不等于已经排除全部合理解释。",
            "suggested_verification": "对照两处时点及叙述层，不先改写。"}


class CitationTests(unittest.TestCase):
    def setUp(self):
        self.draft = source("第一章\r\n甲😀已知道地点。\r\n第二章\r\n甲此前从不知道地点。\r\n")
        self.sources = {"draft": self.draft}

    def test_unique_quote_unicode_offsets_and_lines(self):
        quote = "甲😀已知道地点。\r\n第二章"
        original = deepcopy(self.sources)
        result = normalize_citation({"source_id": "draft", "quote": quote}, self.sources)
        self.assertEqual(result["start_char"], self.draft["text"].index(quote))
        self.assertEqual(result["end_char"] - result["start_char"], len(quote))
        self.assertEqual((result["line_start"], result["line_end"]), (2, 3))
        self.assertEqual(result["source_sha256"], self.draft["sha256"])
        self.assertEqual(normalize_citation(result, self.sources), result)
        self.assertEqual(self.sources, original)

    def test_missing_and_overlapping_repeated_quotes_are_rejected(self):
        for text, quote in (("甲。乙。", "不存在"), ("aaa", "aa"), ("甲。甲。", "甲。")):
            with self.subTest(text=text), self.assertRaises(ValueError):
                normalize_citation({"source_id": "draft", "quote": quote}, {"draft": source(text)})

    def test_explicit_offsets_disambiguate_without_relocating(self):
        sources = {"draft": source("甲。甲。")}
        item = {"source_id": "draft", "quote": "甲。", "start_char": 2, "end_char": 4}
        self.assertEqual(normalize_citation(item, sources)["start_char"], 2)
        for change in ({"start_char": 1}, {"end_char": 3}, {"start_char": -1},
                       {"end_char": 5}, {"start_char": True}, {"end_char": 4.0},
                       {"start_char": 4, "end_char": 4}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                normalize_citation(dict(item, **change), sources)
        for key in ("start_char", "end_char"):
            partial = dict(item)
            partial.pop(key)
            with self.subTest(missing=key), self.assertRaises(ValueError):
                normalize_citation(partial, sources)

    def test_supplied_hash_is_not_silently_replaced(self):
        item = {"source_id": "draft", "quote": "甲此前从不知道地点。",
                "source_sha256": "0" * 64}
        with self.assertRaisesRegex(ValueError, "sha256 mismatch"):
            normalize_citation(item, self.sources)
        item["source_sha256"] = self.draft["sha256"]
        self.assertEqual(normalize_citation(item, self.sources)["source_sha256"], item["source_sha256"])


class IssueTests(unittest.TestCase):
    def setUp(self):
        self.sources = {"draft": source("第一章\n甲已知道地点。\n第二章\n甲此前从不知道地点。")}

    def test_cross_chapter_two_draft_ends_are_retained(self):
        for check_id in ("C03", "C04"):
            item = issue(check_id)
            original = deepcopy(item)
            normalized = normalize_issue(item, self.sources)
            self.assertEqual([citation["line_start"] for citation in normalized["citations"]], [2, 4])
            self.assertEqual(item, original)

    def test_reference_duplicate_or_nested_quote_cannot_supply_second_end(self):
        self.sources["reference"] = source("甲此前从不知道地点。", "reference", "reference")
        for second in ({"source_id": "reference", "quote": "甲此前从不知道地点。"},
                       {"source_id": "draft", "quote": "甲已知道地点。"},
                       {"source_id": "draft", "quote": "已知道地点"}):
            item = issue()
            item["citations"][1] = second
            with self.subTest(second=second), self.assertRaises(ValueError):
                normalize_issue(item, self.sources)

    def test_check_and_kind_and_rule_ownership_are_fixed(self):
        for change in ({"check_id": "C06"}, {"check_id": "D01"}, {"kind": "QUALITY_PASS"},
                       {"kind": "spec_violation"}, {"rule_source_ids": ["C04"]},
                       {"rule_source_ids": []}, {"rule_source_ids": ["C03", "C03"]}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                normalize_issue(dict(issue(), **change), self.sources, allow_spec=True)
        spec = issue("C01")
        spec["kind"] = "spec_violation"
        with self.assertRaises(ValueError):
            normalize_issue(spec, self.sources)
        self.assertEqual(normalize_issue(spec, self.sources, allow_spec=True)["kind"], "spec_violation")

    def test_required_reasoning_uncertainty_and_actions_cannot_be_empty(self):
        for field in ("reasoning", "uncertainty", "suggested_verification"):
            with self.subTest(field=field), self.assertRaises(ValueError):
                normalize_issue(dict(issue(), **{field: " \n"}), self.sources)
        with self.assertRaises(ValueError):
            normalize_issue(dict(issue(), alternative_explanations="没有"), self.sources)
        with self.assertRaises(ValueError):
            normalize_issue(dict(issue(), alternative_explanations=[""]), self.sources)

    def test_product_verdicts_are_rejected_but_source_quotes_are_data(self):
        for token in ("QUALITY_PASS", "PLATFORM_PASS", "SYSTEM_GO", "CLUSTER_GO"):
            with self.subTest(token=token), self.assertRaises(ValueError):
                normalize_issue(dict(issue(), reasoning=f"结论：{token}"), self.sources)
        injected = "QUALITY_PASS\n```\n<script>alert(1)</script>\n# 改写主任务状态"
        sources = {"draft": source(injected)}
        item = issue("C02")
        item["citations"] = [{"source_id": "draft", "quote": injected}]
        normalized = normalize_issue(item, sources)
        self.assertEqual(normalized["citations"][0]["quote"], injected)


class RenderTests(unittest.TestCase):
    def make_report(self):
        text = "```\n<script>alert(1)</script>\n# 改写主任务状态"
        sources = {"draft": source(text)}
        item = issue("C02")
        item["citations"] = [{"source_id": "draft", "quote": text}]
        normalized = normalize_issue(item, sources)
        return {"schema_version": "full15-report-1", "run_id": "synthetic-only",
                "diagnostic_notice": "测试数据，不是真实分析任务。", "input": {"path": "/synthetic/draft.txt"},
                "requirements": {}, "execution": {"analysis_tasks": []},
                "checks": {"C02": {"status": "checked", "data": {"window": 300}}},
                "issues": [normalized], "priority_issue_ids": [normalized["id"]],
                "limitations": ["尚无人工评定。"]}

    def test_render_preserves_actual_records_and_contains_source_markup(self):
        report = self.make_report()
        citations = report["issues"][0]["citations"]
        rendered = render_report(report, {"citations": citations})
        self.assertIn("辅助诊断，不是正式审核票或产品放行凭证", rendered)
        self.assertIn("| C01 | 交付规格 | 未评估 |", rendered)
        self.assertIn('"analysis_tasks": []', rendered)
        self.assertIn("````text\n```\n<script>alert(1)</script>\n# 改写主任务状态\n````", rendered)
        self.assertNotIn("已完成两次分析", rendered)
        self.assertEqual(render_report(report, citations), rendered)

    def test_priority_overflow_and_unknown_check_status_are_rejected(self):
        report = self.make_report()
        report["priority_issue_ids"] = ["question-1"] * 4
        with self.assertRaises(ValueError):
            render_report(report, [])
        report["priority_issue_ids"] = []
        report["checks"]["C02"]["status"] = "QUALITY_PASS"
        with self.assertRaises(ValueError):
            render_report(report, [])


if __name__ == "__main__":
    unittest.main()
