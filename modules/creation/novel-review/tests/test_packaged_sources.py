"""Migration boundary checks; no novels or model analysis are executed."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import review


class PackagedSourceTests(unittest.TestCase):
    def test_rule_paths_cannot_fall_back_to_absolute_or_parent_sources(self):
        for path in ("/old-project/rule.md", "../rule.md", "source-snapshots/../../rule.md"):
            with self.subTest(path=path), self.assertRaises(review.ReviewError) as caught:
                review._package_source_path(path)
            self.assertEqual(caught.exception.code, "invalid_packaged_source_path")

    def test_changed_bundled_rule_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="novel-source-", dir=Path(tempfile.gettempdir()).resolve()) as name:
            root = Path(name)
            package = root / "copied package"
            shutil.copytree(HERE, package, ignore=shutil.ignore_patterns("migration-evidence", "__pycache__"))
            definitions = json.loads((package / "checks.json").read_text())
            target = package / definitions["checks"][0]["sources"][0]["path"]
            target.write_bytes(target.read_bytes() + b"changed")
            draft = root / "synthetic.txt"
            draft.write_text("# 第一章\n迁移边界测试，不是小说效果样本。", encoding="utf-8")
            with patch.object(review, "HERE", package), self.assertRaises(review.ReviewError) as caught:
                review.prepare_run(draft, run_dir=root / "run")
            self.assertEqual(caught.exception.code, "source_hash_mismatch")

    def test_bundled_rule_symlink_cannot_escape_the_package(self):
        with tempfile.TemporaryDirectory(prefix="novel-link-", dir=Path(tempfile.gettempdir()).resolve()) as name:
            root = Path(name)
            snapshots = root / "source-snapshots"
            snapshots.mkdir()
            external = root / "external.txt"
            external.write_text("not a bundled source", encoding="utf-8")
            (snapshots / "rule.md").symlink_to(external)
            with patch.object(review, "HERE", root), self.assertRaises(review.ReviewError) as caught:
                review._package_source_path("source-snapshots/rule.md")
            self.assertEqual(caught.exception.code, "invalid_packaged_source_path")


if __name__ == "__main__":
    unittest.main()
