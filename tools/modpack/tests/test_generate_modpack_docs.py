"""Regression tests for fixture-only contextual compatibility generation."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from tools.modpack.generate_modpack_docs import build_docs, evaluate_maven_version_range  # noqa: E402


REGRESSION_FIXTURE = ROOT / "tools/modpack/fixtures/contextual-compatibility-regressions.json"
ARTIFACT_FIXTURE = ROOT / "tools/modpack/fixtures/sanitized-artifact-inventory-v1.json"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class MavenVersionRangeTests(unittest.TestCase):
    def test_shared_range_corpus(self) -> None:
        fixture = load_json(REGRESSION_FIXTURE)
        for case in fixture["versionRangeCases"]:
            with self.subTest(version=case["version"], declared_range=case["range"]):
                self.assertEqual(
                    evaluate_maven_version_range(case["version"], case["range"]),
                    case["expected"],
                )


class FixtureOnlyDocumentationTests(unittest.TestCase):
    def test_named_regressions_jarjar_and_determinism(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            first = base / "first"
            second = base / "second"
            build_docs(ROOT, first, artifact_fixture=ARTIFACT_FIXTURE)
            build_docs(ROOT, second, artifact_fixture=ARTIFACT_FIXTURE)

            first_files = {
                path.relative_to(first).as_posix(): path.read_bytes()
                for path in first.rglob("*")
                if path.is_file()
            }
            second_files = {
                path.relative_to(second).as_posix(): path.read_bytes()
                for path in second.rglob("*")
                if path.is_file()
            }
            self.assertEqual(first_files, second_files)

            document = load_json(first / "compatibilidade.json")
            matrix = {item["modId"]: item for item in document["matrix"]}
            expected = {
                "armourers_workshop": ("incompatible", "canonical-conflict"),
                "epicfight": ("incompatible", "canonical-conflict"),
                "killcam": ("unknown", "reference-divergence"),
                "openloader": ("incompatible", "canonical-conflict"),
                "preloading_tricks": ("unknown", "reference-only"),
                "wom": ("incompatible", "canonical-conflict"),
            }
            for component_id, (status, classification) in expected.items():
                with self.subTest(component_id=component_id):
                    self.assertEqual(matrix[component_id]["status"], status)
                    self.assertEqual(matrix[component_id]["classification"], classification)

            self.assertEqual(matrix["cumulus_menus"]["componentKind"], "embedded-library")
            self.assertEqual(matrix["nitrogen_internals"]["componentKind"], "embedded-library")
            self.assertFalse(
                any(
                    check["dependency"] == "neoforge"
                    and check["environmentVersion"] in {"47.4.0", "47.4.4"}
                    for item in document["matrix"]
                    for check in item["environmentChecks"]
                )
            )

    def test_fixture_provenance_is_committed_and_runtime_free(self) -> None:
        fixture = load_json(ARTIFACT_FIXTURE)
        self.assertEqual(fixture["schemaVersion"], 1)
        self.assertGreater(len(fixture["artifacts"]), 250)
        rendered = json.dumps(fixture, ensure_ascii=False)
        self.assertNotIn("Launcher/workspace", rendered)
        self.assertNotIn("Servidor/workspace", rendered)


if __name__ == "__main__":
    unittest.main()
