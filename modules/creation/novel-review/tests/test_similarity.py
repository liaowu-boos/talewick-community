"""Focused tests for lexical overlap, exact citations, and bounded display work."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import unittest


REVIEW_ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "novel_review_similarity", REVIEW_ROOT / "similarity.py"
)
assert SPEC is not None and SPEC.loader is not None
similarity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(similarity)


def source(source_id: str, text: str, path: str | None = None) -> dict:
    return {
        "source_id": source_id,
        "path": path if path is not None else f"{source_id}.txt",
        "text": text,
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }


def compact(text: str) -> str:
    return re.sub(r"""[\s，。！？、；：“”‘’…,.!?;:'"—-]+""", "", text)


def ngrams(text: str, size: int) -> set[str]:
    normalized = compact(text)
    return {
        normalized[index : index + size]
        for index in range(len(normalized) - size + 1)
    }


class SimilarityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        document = json.loads(
            (REVIEW_ROOT / "acceptance" / "functional_cases.json").read_text(
                encoding="utf-8"
            )
        )
        cls.cases = {case["case_id"]: case for case in document["cases"]}

    def assert_citations(self, match: dict, draft: dict, reference: dict) -> None:
        for role, original in (("draft", draft), ("reference", reference)):
            citation = match[role]
            self.assertEqual(citation["source_id"], original["source_id"])
            self.assertEqual(citation["source_sha256"], original["sha256"])
            self.assertGreaterEqual(citation["start_char"], 0)
            self.assertLess(citation["start_char"], citation["end_char"])
            self.assertLessEqual(citation["end_char"], len(original["text"]))
            self.assertEqual(
                citation["quote"],
                original["text"][citation["start_char"] : citation["end_char"]],
            )
        self.assertEqual(compact(match["draft"]["quote"]), compact(match["reference"]["quote"]))
        self.assertEqual(
            match["normalized_match_length"], len(compact(match["draft"]["quote"]))
        )

    def test_f11_reuses_fixture_and_locates_both_sources(self) -> None:
        case = self.cases["F11"]
        draft = source("D", case["input"]["text"])
        reference = source("R1", case["input"]["references"][0]["text"])
        result = similarity.scan_similarity(draft, [reference])
        self.assertEqual(result["scanned_count"], 1)
        self.assertTrue(result["matches"])
        anchor = case["expected"]["normalized_anchor"]
        self.assertTrue(
            any(anchor in compact(match["draft"]["quote"]) for match in result["matches"])
        )
        for match in result["matches"]:
            self.assert_citations(match, draft, reference)
        self.assertEqual(
            result["sources"][0]["overlap_ngram_count"],
            len(ngrams(draft["text"], 12) & ngrams(reference["text"], 12)),
        )

    def test_f12_same_raw_sha_copy_is_excluded(self) -> None:
        case = self.cases["F12"]
        draft = source("D", case["input"]["text"])
        reference = source("R1", case["input"]["references"][0]["text"])
        result = similarity.scan_similarity(draft, [reference])
        self.assertEqual(result["scanned_count"], 0)
        self.assertEqual(result["matches"], [])
        self.assertEqual(
            [entry["reason"] for entry in result["excluded_sources"]], ["same_sha256"]
        )

    def test_same_path_is_excluded_even_when_supplied_hashes_differ(self) -> None:
        draft = source("D", "同一路径的当前内容", "/examples/draft.txt")
        self_reference = source("OLD", "同一路径的另一版本", "/examples/./draft.txt")
        other = source("R", "另一个候选原文")
        result = similarity.scan_similarity(draft, [self_reference, other], ngram_size=3)
        self.assertEqual(result["scanned_count"], 1)
        self.assertEqual(result["sources"][0]["source_id"], "R")
        self.assertEqual(result["excluded_sources"][0]["reason"], "same_path")

    def test_punctuation_differences_preserve_exact_original_offsets(self) -> None:
        draft = source("D", "🙂前言\n甲，乙。丙！丁？戊、己；庚：“辛”壬‘癸’…终。")
        reference = source("R", "另段：甲 乙丙丁戊己庚辛壬癸终！后文")
        result = similarity.scan_similarity(draft, [reference], ngram_size=4)
        match = result["matches"][0]
        self.assert_citations(match, draft, reference)
        self.assertNotEqual(match["draft"]["quote"], match["reference"]["quote"])
        self.assertEqual(match["draft"]["start_char"], draft["text"].index("甲"))
        self.assertEqual(match["draft"]["end_char"], draft["text"].index("终") + 1)
        self.assertEqual(match["reference"]["start_char"], reference["text"].index("甲"))
        self.assertEqual(match["normalized_match_length"], len("甲乙丙丁戊己庚辛壬癸终"))

    def test_long_repeated_text_uses_one_anchor_instead_of_position_pairs(self) -> None:
        draft = source("D", "甲" * 20_000 + "乙")
        reference = source("R", "甲" * 19_999 + "丙")
        result = similarity.scan_similarity(draft, [reference])
        comparison = result["sources"][0]
        self.assertEqual(comparison["overlap_ngram_count"], 1)
        self.assertEqual(comparison["anchor_expansions"], 1)
        self.assertEqual(comparison["normalized_match_length"], 19_999)
        self.assertFalse(result["display_exhaustive"])
        self.assertTrue(result["display_truncated"])
        self.assertTrue(comparison["matching_ngrams_have_repeated_occurrences"])
        self.assertEqual(len(result["matches"]), 1)
        self.assert_citations(result["matches"][0], draft, reference)

    def test_anchor_budget_does_not_truncate_actual_ngram_count(self) -> None:
        block_count = similarity.MAX_ANCHORS_PER_SOURCE + 4
        blocks = [
            "".join(chr(0x4E00 + index * 8 + offset) for offset in range(6))
            for index in range(block_count)
        ]
        draft = source("D", "∆".join(blocks))
        reference = source("R", "Ω".join(blocks))
        result = similarity.scan_similarity(draft, [reference], ngram_size=3)
        comparison = result["sources"][0]
        self.assertEqual(comparison["overlap_ngram_count"], block_count * 4)
        self.assertEqual(comparison["anchor_expansions"], similarity.MAX_ANCHORS_PER_SOURCE)
        self.assertTrue(comparison["anchor_search_limited"])
        self.assertTrue(result["display_truncated"])
        self.assertEqual(len(result["matches"]), 5)
        for match in result["matches"]:
            self.assert_citations(match, draft, reference)

    def test_candidate_limit_is_hard_and_inclusive(self) -> None:
        draft = source("D", "一份待检查的正文")
        references = [source(f"R{index}", f"另一份材料{index}") for index in range(51)]
        with self.assertRaisesRegex(ValueError, "50"):
            similarity.scan_similarity(draft, references)
        result = similarity.scan_similarity(draft, references[:50])
        self.assertEqual(result["scanned_count"], 50)

    def test_output_is_stable_inputs_unchanged_and_display_cap_is_global(self) -> None:
        draft = source("D", "一二三四五六七八九十甲乙丙丁")
        references = [
            source(f"R{index}", f"前{index}：{draft['text']}，后{index}")
            for index in range(7)
        ]
        before = copy.deepcopy((draft, references))
        first = similarity.scan_similarity(draft, references)
        second = similarity.scan_similarity(draft, references)
        self.assertEqual(first, second)
        self.assertEqual((draft, references), before)
        self.assertEqual(first["scanned_count"], 7)
        self.assertEqual(len(first["matches"]), 5)
        self.assertEqual(
            [match["reference"]["source_id"] for match in first["matches"]],
            [f"R{index}" for index in range(5)],
        )
        self.assertTrue(first["display_truncated"])
        self.assertEqual([item["displayed_match_count"] for item in first["sources"]], [1, 1, 1, 1, 1, 0, 0])

    def test_short_text_and_invalid_options_are_explicit(self) -> None:
        draft = source("D", "甲乙")
        reference = source("R", "丙丁")
        result = similarity.scan_similarity(draft, [reference])
        self.assertEqual(result["sources"][0]["overlap_ngram_count"], 0)
        self.assertEqual(result["sources"][0]["normalized_match_length"], 0)
        self.assertEqual(result["matches"], [])
        for options in ({"ngram_size": 0}, {"ngram_size": True}, {"match_limit": 6}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                similarity.scan_similarity(draft, [reference], **options)


if __name__ == "__main__":
    unittest.main()
