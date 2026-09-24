"""Exercise release guards through real processes without registry writes."""

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/npm/release.py"
FIXTURE = ROOT / "tests/release/fixtures/release_cli.py"
PACKAGE = "@example/tool"
REPOSITORY = "example/tool"
REGISTRY = "https://registry.npmjs.org/"
SOURCE_SHA = "a" * 40


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cwd = Path(self.temp.name)
        self.metadata = {
            "name": PACKAGE, "version": "1.0.0",
            "repository": {"url": "git+https://github.com/example/tool.git"},
        }
        self.env = {
            **os.environ,
            "PKG_NAME": PACKAGE, "PKG_VERSION": "1.0.0", "REPO": REPOSITORY,
            "REGISTRY": REGISTRY, "SOURCE_SHA": SOURCE_SHA,
            "NPM_USER": "example", "WORKFLOW_FILE": "release.yml",
            "ENVIRONMENT": "npm-release", "WORKFLOW_REVIEWED": "1",
            "DRY_RUN": "0", "CONFIRM": "", "SCENARIO": "absent",
            "NPM_BIN": str(self.cwd / "npm"), "GH_BIN": str(self.cwd / "gh"),
            "GIT_BIN": str(self.cwd / "git"), "CALL_LOG": str(self.cwd / "calls.jsonl"),
            "REVIEWER": "example", "TAG_PATTERN": "v*", "RULESET_NAME": "release-tags",
        }
        for name in ("npm", "gh", "git"):
            tool = self.cwd / name
            tool.write_text(f"#!{sys.executable}\n" + FIXTURE.read_text())
            tool.chmod(0o700)
        workflow = self.cwd / ".github/workflows/release.yml"
        workflow.parent.mkdir(parents=True)
        workflow.write_text("# Synthetic workflow: policy review is a separate gate.\n")
        self.pack()

    def pack(self):
        (self.cwd / "package.json").write_text(json.dumps(self.metadata))
        artifact = self.cwd / "reviewed.tgz"
        with tarfile.open(artifact, "w:gz") as archive:
            data = json.dumps(self.metadata).encode()
            info = tarfile.TarInfo("package/package.json")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        integrity = base64.b64encode(hashlib.sha512(artifact.read_bytes()).digest()).decode()
        self.env.update(ARTIFACT=str(artifact), ARTIFACT_INTEGRITY="sha512-" + integrity)

    def run_helper(self, action, **env):
        return subprocess.run(
            [sys.executable, str(HELPER), action], cwd=self.cwd,
            env={**self.env, **env}, text=True, capture_output=True, check=False,
        )

    def calls(self):
        log = Path(self.env["CALL_LOG"])
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def assert_no_mutation(self):
        for call in self.calls():
            args = call[1:]
            self.assertNotIn("publish", args)
            self.assertNotIn("github", args)
            self.assertNotIn("set", args)
            self.assertNotIn("--method", args)

    def test_preflight_checks_explicit_identity_and_registry(self):
        result = self.run_helper("preflight")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertTrue(any("whoami" in call for call in calls))
        for call in calls:
            if call[0] == "npm" and "--version" not in call and call[1:3] != ["config", "get"]:
                self.assertIn("--registry=" + REGISTRY, call)
                self.assertNotIn("--@example:registry=" + REGISTRY, call)
        self.assert_no_mutation()

    def test_registry_metadata_accepts_the_shape_npm_12_returns(self):
        # npm 12 answers a version-qualified view with a one-element list while npm 11 answers with
        # the object, so the tool has to serve both or a supported npm becomes unusable.
        result = self.run_helper("verify", SCENARIO="array-metadata")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("verified", result.stdout)

    def test_registry_metadata_still_rejects_an_unexpected_shape(self):
        # A response that describes anything other than one version must not be normalised away.
        result = self.run_helper("verify", SCENARIO="double-metadata")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("object", result.stderr)

    def test_interactive_prompt_is_answered_so_an_otp_read_cannot_stall(self):
        # npm opens the browser page only after a keypress, and it waits for the browser afterwards.
        # An unanswered prompt stalls the read until the window closes, so the prompt is answered.
        script = (
            "import sys, time\n"
            "sys.stdout.write('Press ENTER to open in the browser...')\n"
            "sys.stdout.flush()\n"
            "if sys.stdin.readline() == '':\n"
            "    sys.exit(3)\n"
            "sys.exit(0)\n"
        )
        sys.path.insert(0, str(ROOT / "scripts/npm"))
        import execution
        result = execution.run([sys.executable, "-c", script], tty=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_preflight_rejects_a_redirected_registry(self):
        for scenario in ("rogue-registry", "rogue-scoped-registry"):
            with self.subTest(scenario=scenario):
                result = self.run_helper("preflight", SCENARIO=scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("redirected", result.stderr)
        self.assert_no_mutation()

    def test_bootstrap_publishes_reviewed_tarball_without_hooks(self):
        result = self.run_helper("bootstrap-publish", CONFIRM="bootstrap-publish")
        self.assertEqual(result.returncode, 0, result.stderr)
        publishes = [call for call in self.calls() if "publish" in call]
        self.assertEqual(len(publishes), 1)
        self.assertIn(str(Path(self.env["ARTIFACT"]).resolve()), publishes[0])
        self.assertIn("--ignore-scripts", publishes[0])
        self.assertIn("--access=public", publishes[0])
        self.assertIn("--registry=" + REGISTRY, publishes[0])

    def test_bootstrap_dry_run_never_calls_publish(self):
        result = self.run_helper("bootstrap-publish", DRY_RUN="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("dry-run:", result.stdout)
        self.assert_no_mutation()

    def test_bootstrap_refuses_existing_auth_errors_and_network_errors(self):
        for scenario in ("existing", "auth-error", "network-error", "fake-404", "wrong-user"):
            with self.subTest(scenario=scenario):
                result = self.run_helper("bootstrap-publish", CONFIRM="bootstrap-publish", SCENARIO=scenario)
                self.assertNotEqual(result.returncode, 0)
        self.assert_no_mutation()

    def test_bootstrap_retries_registry_readback_after_write(self):
        result = self.run_helper("bootstrap-publish", CONFIRM="bootstrap-publish", SCENARIO="lag")
        self.assertEqual(result.returncode, 0, result.stderr)
        reads = [call for call in self.calls() if "@example/tool@1.0.0" in call]
        self.assertEqual(len(reads), 2)
        self.assertEqual(sum("publish" in call for call in self.calls()), 1)

    def test_bootstrap_does_not_retry_a_mismatched_manifest(self):
        result = self.run_helper("bootstrap-publish", CONFIRM="bootstrap-publish", SCENARIO="wrong-manifest")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match", result.stderr)
        reads = [call for call in self.calls() if "@example/tool@1.0.0" in call]
        self.assertEqual(len(reads), 1)

    def test_read_backoff_repeats_transport_failures_only(self):
        sys.path.insert(0, str(ROOT / "scripts/npm"))
        self.addCleanup(sys.path.remove, str(ROOT / "scripts/npm"))
        from execution import ReadFailure, ReleaseError, read_with_retry

        attempts = []

        def trailing():
            attempts.append(1)
            if len(attempts) < 3:
                raise ReadFailure("not served yet")
            return "served"

        self.assertEqual(read_with_retry(trailing, attempts=3, backoff=0.001, cap=0.001), "served")
        self.assertEqual(len(attempts), 3)

        def mismatched():
            attempts.append(1)
            raise ReleaseError("wrong shape")

        with self.assertRaises(ReleaseError):
            read_with_retry(mismatched, attempts=3, backoff=0.001, cap=0.001)
        self.assertEqual(len(attempts), 4)

    def test_publish_failure_is_not_retried(self):
        result = self.run_helper("bootstrap-publish", CONFIRM="bootstrap-publish", SCENARIO="publish-error")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outcome unknown", result.stderr)
        self.assertEqual(sum("publish" in call for call in self.calls()), 1)

    def test_trust_refuses_dirty_source(self):
        result = self.run_helper("configure-trust", CONFIRM="configure-trust", SCENARIO="dirty")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("clean", result.stderr)
        self.assert_no_mutation()

    def test_mutations_require_specific_confirmation(self):
        for action in ("bootstrap-publish", "configure-trust", "harden-publishing", "setup-github-release"):
            with self.subTest(action=action):
                self.assertNotEqual(self.run_helper(action, CONFIRM="yes").returncode, 0)
        self.assert_no_mutation()

    def test_preflight_rejects_invalid_or_mismatched_inputs(self):
        cases = [
            {"PKG_NAME": "other"}, {"REPO": "wrong/repo"}, {"REGISTRY": ""},
            {"REGISTRY": "https://user:secret@registry.npmjs.org/"},
            {"SOURCE_SHA": "b" * 40}, {"DRY_RUN": "true"},
            {"SCENARIO": "dirty"}, {"SCENARIO": "old-npm"},
        ]
        for env in cases:
            with self.subTest(env=env):
                self.assertNotEqual(self.run_helper("preflight", **env).returncode, 0)
        self.assert_no_mutation()

    def test_bootstrap_rejects_changed_artifact(self):
        Path(self.env["ARTIFACT"]).write_bytes(b"different bytes")
        result = self.run_helper("bootstrap-publish", CONFIRM="bootstrap-publish")
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_mutation()

    def test_conflicting_publish_config_fails_closed(self):
        for config in ({"registry": "https://other.example/"}, {"access": "restricted"}, {"tag": "other"}):
            self.metadata["publishConfig"] = config
            self.pack()
            result = self.run_helper("bootstrap-publish", CONFIRM="bootstrap-publish")
            self.assertNotEqual(result.returncode, 0)
        self.assert_no_mutation()

    def test_configure_trust_requires_review_and_refuses_conflict(self):
        for env in ({"WORKFLOW_REVIEWED": "0"}, {"SCENARIO": "trust-conflict"}):
            result = self.run_helper("configure-trust", CONFIRM="configure-trust", **env)
            self.assertNotEqual(result.returncode, 0)
        self.assert_no_mutation()

    def test_configure_trust_limits_permissions_and_verifies_result(self):
        result = self.run_helper("configure-trust", CONFIRM="configure-trust")
        self.assertEqual(result.returncode, 0, result.stderr)
        mutation = next(call for call in self.calls() if "github" in call)
        self.assertIn("--allow-publish", mutation)
        self.assertNotIn("--allow-stage-publish", mutation)
        self.assertIn("--env=npm-release", mutation)
        reads = [call for call in self.calls() if call[1:3] == ["trust", "list"]]
        self.assertEqual(len(reads), 2)
        for call in reads:
            self.assertIn("--color=false", call)
            self.assertNotIn("--@example:registry=" + REGISTRY, call)

    def test_verify_requires_matching_integrity_and_exact_trust(self):
        result = self.run_helper("verify", SCENARIO="published")
        self.assertEqual(result.returncode, 0, result.stderr)
        for scenario in ("bad-integrity", "trust-conflict", "extra-permission", "stage-only", "private-access"):
            with self.subTest(scenario=scenario):
                self.assertNotEqual(self.run_helper("verify", SCENARIO=scenario).returncode, 0)
        self.assert_no_mutation()

    def test_github_dry_run_shows_payloads_without_mutating(self):
        result = self.run_helper("setup-github-release", DRY_RUN="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"can_admins_bypass": false', result.stdout)
        self.assertIn('"type": "tag"', result.stdout)
        self.assert_no_mutation()
        self.assertTrue(any("--paginate" in call for call in self.calls()))

    def test_github_setup_creates_then_rechecks_and_is_idempotent(self):
        result = self.run_helper("setup-github-release", CONFIRM="setup-github-release")
        self.assertEqual(result.returncode, 0, result.stderr)
        count = sum("--method" in call for call in self.calls())
        self.assertEqual(count, 3)
        result = self.run_helper("setup-github-release", CONFIRM="setup-github-release")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum("--method" in call for call in self.calls()), count)

    def test_github_partial_failure_stops_without_retry(self):
        result = self.run_helper("setup-github-release", CONFIRM="setup-github-release", SCENARIO="policy-error")
        self.assertNotEqual(result.returncode, 0)
        mutations = [call for call in self.calls() if "--method" in call]
        self.assertEqual(len(mutations), 2)
        self.assertFalse(any(call[4] == "repos/example/tool/rulesets" for call in mutations))

    def test_github_conflicting_branch_policy_fails_before_mutation(self):
        result = self.run_helper("setup-github-release", CONFIRM="setup-github-release", SCENARIO="branch-policy")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conflict", result.stderr)
        self.assert_no_mutation()

    def test_hardening_uses_explicit_registry_without_claiming_verification(self):
        result = self.run_helper("harden-publishing", CONFIRM="harden-publishing")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("mfa=publish", next(call for call in self.calls() if "set" in call))
        self.assertIn("verify", result.stdout)


if __name__ == "__main__":
    unittest.main()
