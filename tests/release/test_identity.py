"""Tie the static release identity to the manifest it publishes.

A scope, repository, tag, or environment typo in scripts/npm/target.env stays
invisible until the helper acts on it, and by then the mistake can be a
registry write that cannot be undone. These checks move that discovery into
the suite, where the fix is still a commit.
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET_ENV = ROOT / "scripts/npm/target.env"
WORKFLOW_DIR = ROOT / ".github/workflows"
ASSIGNMENT = re.compile(r"^([A-Z_]+)='([^']*)'$")
REQUIRED_SETTINGS = ("PKG_NAME", "REPO", "REGISTRY", "NPM_USER", "WORKFLOW_FILE", "ENVIRONMENT", "TAG_PATTERN")


def target_settings():
    settings = {}
    for line in TARGET_ENV.read_text().splitlines():
        match = ASSIGNMENT.match(line.strip())
        if match:
            settings[match.group(1)] = match.group(2)
    return settings


class ReleaseIdentityTests(unittest.TestCase):
    def setUp(self):
        self.settings = target_settings()
        self.manifest = json.loads((ROOT / "package.json").read_text())
        self.workflow = (WORKFLOW_DIR / self.settings["WORKFLOW_FILE"]).read_text()

    def test_target_env_declares_every_setting(self):
        for key in REQUIRED_SETTINGS:
            self.assertIn(key, self.settings)

    def test_package_name_matches_the_manifest(self):
        self.assertEqual(self.settings["PKG_NAME"], self.manifest["name"])

    def test_the_package_is_publishable(self):
        self.assertIsNot(self.manifest.get("private"), True)
        self.assertEqual(self.manifest["publishConfig"]["access"], "public")

    def test_repository_and_registry_match_the_manifest(self):
        repository = self.manifest["repository"]
        url = repository["url"] if isinstance(repository, dict) else repository
        self.assertIn(self.settings["REPO"], url)
        self.assertEqual(self.manifest["publishConfig"]["registry"], self.settings["REGISTRY"])

    def test_release_workflow_carries_the_declared_gates(self):
        self.assertIn("environment: " + self.settings["ENVIRONMENT"], self.workflow)
        self.assertIn("id-token: write", self.workflow)
        self.assertIn("tags: ['" + self.settings["TAG_PATTERN"] + "']", self.workflow)
        self.assertIn("npm publish --provenance --access public", self.workflow)

    def test_the_bundle_patch_row_names_this_package(self):
        patch = (ROOT / "cordis.patch.yml").read_text()
        self.assertIn("name: '" + self.settings["PKG_NAME"] + "'", patch)


if __name__ == "__main__":
    unittest.main()
