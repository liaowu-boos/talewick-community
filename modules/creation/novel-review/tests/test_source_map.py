"""Focused source-map regression tests; no corpus or production calls."""

import hashlib
import json
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from source_map import build_source_map, check_spec, window_spans


def make_map(text, **kwargs):
    return build_source_map(text, "draft", hashlib.sha256(text.encode("utf-8")).hexdigest(), **kwargs)


class SourceMapTests(unittest.TestCase):
    def test_existing_f01_f02(self):
        cases = json.loads((ROOT / "acceptance" / "functional_cases.json").read_text(encoding="utf-8"))
        selected = [case for case in cases["cases"] if case["case_id"] in {"F01", "F02"}]
        self.assertEqual(len(selected), 2)
        for case in selected:
            with self.subTest(case=case["case_id"]):
                mapped = make_map(case["input"]["text"])
                result = check_spec(mapped, case["input"]["requirements"])
                for key, expected in case["expected"].items():
                    self.assertEqual(result["data"][key], expected)
                self.assertEqual(len(result["violations"]), 1 if case["case_id"] == "F01" else 0)

    def test_titles_crlf_preface_and_unicode_offsets(self):
        text = "# 书名\r\n这是前言。\r\n\r\n## 第一章 开端\r\n甲😀乙。\r\n\r\n第二章：归来\r\n丙 丁。\r\n"
        mapped = make_map(text)
        self.assertEqual(mapped["body_han_count"], 8)
        self.assertEqual(mapped["body_non_whitespace_count"], 12)
        self.assertTrue(mapped["chapter_boundaries_known"])
        self.assertEqual([item["number"] for item in mapped["chapters"]], [1, 2])
        self.assertEqual(mapped["chapters"][0]["start_char"], text.index("甲"))
        self.assertEqual(mapped["chapters"][0]["end_char"], text.index("第二章"))
        paragraphs = [text[item["start_char"]:item["end_char"]] for item in mapped["paragraphs"]]
        self.assertEqual(paragraphs, ["这是前言。", "甲😀乙。", "丙 丁。"])
        for line in mapped["lines"]:
            self.assertNotIn("\r", text[line["start_char"]:line["end_char"]])
        self.assertEqual(mapped["text"], text)

    def test_windows_preserve_text_and_non_whitespace_budget(self):
        text = "# 第四章\r\n甲 乙。\r\n# 第五章\r\n丙\n丁！\r\n"
        mapped = make_map(text)
        for which, limit, expected in (
                ("body_prefix", 4, ["甲 乙。", "丙"]),
                ("ch4_suffix", 2, ["乙。"]),
                ("ch5_prefix", 2, ["丙\n丁"])):
            with self.subTest(which=which):
                spans = window_spans(mapped, which, limit)
                quotes = [text[item["start_char"]:item["end_char"]] for item in spans]
                self.assertEqual(quotes, expected)
                self.assertEqual(sum(not char.isspace() for char in "".join(quotes)), limit)
        self.assertEqual(window_spans(mapped, "body_prefix", 0), [])
        with self.assertRaises(ValueError):
            window_spans(mapped, "body_prefix", True)

    def test_ambiguous_or_duplicate_chapters_are_visible(self):
        for text, code in (
                ("没有明确章名的正文。", "no_explicit_chapters"),
                ("第十十章\n甲。\n", "unresolved_chapter_heading"),
                ("# 第四章\n甲。\n# 第四章\n乙。\n# 第五章\n丙。", "duplicate_chapter_numbers"),
                ("第1章\n甲。\n第3章\n乙。", "nonconsecutive_chapter_numbers")):
            with self.subTest(code=code):
                mapped = make_map(text)
                self.assertFalse(mapped["chapter_boundaries_known"])
                self.assertIn(code, [item["code"] for item in mapped["chapter_boundary_issues"]])
                self.assertEqual(window_spans(mapped, "ch4_suffix", 10), [])
                result = check_spec(mapped, {"min_chapters": 2})
                self.assertEqual(result["status"], "insufficient_evidence")
                self.assertEqual(result["violations"], [])

    def test_limits_do_not_truncate(self):
        text = "甲" * 20001
        mapped = make_map(text)
        self.assertEqual(mapped["body_non_whitespace_count"], 20001)
        self.assertEqual(mapped["body_ranges"], [{"start_char": 0, "end_char": 20001}])
        self.assertEqual(mapped["text"], text)
        self.assertIn("body_non_whitespace_limit", mapped["limits_exceeded"])
        chapters = make_map("\n".join(f"第{number}章\n甲" for number in range(1, 22)))
        self.assertEqual(chapters["explicit_chapter_count"], 21)
        self.assertEqual(chapters["body_han_count"], 21)
        self.assertIn("explicit_chapter_limit", chapters["limits_exceeded"])
        self.assertEqual(make_map("甲" * 20000)["limits_exceeded"], [])

    def test_count_basis_and_statistics_only(self):
        mapped = make_map("第一章\n甲 乙。\n")
        result = check_spec(mapped, {})
        self.assertEqual(result["data"]["length_result"], "statistics_only")
        self.assertEqual(result["data"]["chapter_result"], "statistics_only")
        self.assertEqual(result["violations"], [])
        unknown = check_spec(mapped, {"min_body_length": 100})
        self.assertEqual(unknown["status"], "insufficient_evidence")
        self.assertEqual(unknown["violations"], [])
        explicit = check_spec(mapped, {"count_basis": "non_whitespace", "max_body_length": 2})
        self.assertEqual(explicit["data"]["length_result"], "above_maximum")
        self.assertEqual(explicit["violations"][0]["actual"], 3)

    def test_invalid_requirements_are_rejected(self):
        mapped = make_map("第一章\n甲。")
        for requirement in (
                {"min_body_length": True}, {"max_chapters": False},
                {"min_body_length": -1}, {"max_body_length": 1.5},
                {"min_chapters": "2"}, {"min_body_length": 10, "max_body_length": 9},
                {"min_chapters": 3, "max_chapters": 2}, {"count_basis": "unspecified"}):
            with self.subTest(requirement=requirement), self.assertRaises(ValueError):
                check_spec(mapped, requirement)

    def test_explicit_body_bounds_keep_original_offsets(self):
        text = "说明不属于稿件\r\n第一章\r\n甲𠮷。\r\n提交说明"
        start, end = text.index("第一章"), text.index("提交说明")
        mapped = make_map(text, body_start=start, body_end=end)
        self.assertEqual(mapped["body_han_count"], 2)
        self.assertEqual(mapped["body_non_whitespace_count"], 3)
        self.assertEqual(mapped["chapters"][0]["start_char"], text.index("甲"))
        self.assertEqual(window_spans(mapped, "body_prefix", 2),
                         [{"start_char": text.index("甲"), "end_char": text.index("甲") + 2}])
        for kwargs in ({"body_start": True}, {"body_end": -1},
                       {"body_start": 5, "body_end": 2}, {"body_end": len(text) + 1}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                make_map(text, **kwargs)


if __name__ == "__main__":
    unittest.main()
