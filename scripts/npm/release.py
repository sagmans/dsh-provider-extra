"""Optional release operations; run from an explicitly selected target checkout.

Adapted from the reusable helper in the pi-extension-template repository. The
target owns no npm token: the first publication is bootstrapped by the release
owner, and every later publication trusts this repository's workflow instead.
"""

import argparse
import base64
import hashlib
import os
from pathlib import Path
import re
import sys
import tarfile

from execution import ReleaseError, mutate, read_json, read_with_retry, require, run, setting
from github_release import setup_github

REGISTRY = "https://registry.npmjs.org/"
MINIMUM_NPM = (11, 15, 0)
PACKAGE_PATTERN = r"@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*"
REPOSITORY_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*"
NAME_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._-]*"
VERSION_PATTERN = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?"
SHA_PATTERN = r"[0-9a-f]{40}(?:[0-9a-f]{24})?"
MANIFEST_PATH = "package/package.json"
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_MEMBERS = 10000
MAX_ARTIFACT_BYTES = 100 * 1024 * 1024
MUTATIONS = ("bootstrap-publish", "configure-trust", "harden-publishing", "setup-github-release")
ACTIONS = ("preflight", "verify", *MUTATIONS)
CREATE_PACKAGE = "createPackage"
CREATE_STAGED_PACKAGE = "createStagedPackage"
# npmjs.com answers a publish grant with stage publish included; a stage-only grant carries no publish authority.
EXPECTED_TRUST_PERMISSIONS = frozenset({CREATE_PACKAGE, CREATE_STAGED_PACKAGE})
TRUST_PERMISSION_LABELS = {"publish": CREATE_PACKAGE, "stage publish": CREATE_STAGED_PACKAGE}
TRUST_FIELDS = ("type", "file", "repository", "environment")
PERMISSIONS_FIELD = "permissions"
EMPTY_CONFIG_VALUES = ("", "undefined", "null")


def parse_trust_list(text):
    """Read npm's human-readable trust output; npm suppresses the browser authentication URL in JSON mode."""
    configs = []
    current = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            if current:
                configs.append(current)
                current = {}
            continue
        key, separator, value = line.partition(":")
        key, value = key.strip(), value.strip()
        if not separator or not value:
            continue
        if key in TRUST_FIELDS:
            current[key] = value
        elif key == PERMISSIONS_FIELD:
            current[PERMISSIONS_FIELD] = [TRUST_PERMISSION_LABELS.get(label, label)
                                          for label in (item.strip() for item in value.split(",")) if label]
    if current:
        configs.append(current)
    return configs


def single_metadata(response):
    """Normalise the registry metadata npm returns for one version.

    npm 11 answers with the metadata object and npm 12 wraps the same object in a one-element list,
    so the tool must accept both to serve either npm. An empty or longer list describes something
    other than one version and is left for the shape checks to reject.
    """
    if isinstance(response, list) and len(response) == 1:
        return response[0]
    return response


class Target:
    def __init__(self):
        require(os.environ.get("DRY_RUN", "0") in ("0", "1"), "DRY_RUN must be 0 or 1")
        self.package = setting("PKG_NAME", PACKAGE_PATTERN)
        self.version = setting("PKG_VERSION", VERSION_PATTERN)
        self.repo = setting("REPO", REPOSITORY_PATTERN)
        require(setting("REGISTRY") == REGISTRY, "this helper supports only https://registry.npmjs.org/")
        self.npm_bin = os.environ.get("NPM_BIN", "npm")
        self.git_bin = os.environ.get("GIT_BIN", "git")
        self.gh_bin = os.environ.get("GH_BIN", "gh")
        self.scope = self.package.split("/")[0]
        self.metadata = read_json(Path("package.json").read_text())
        self.validate_metadata(self.metadata)

    def npm_command(self, *args):
        # Every call pins the registry; authenticate() rejects a configured redirection, because the scope
        # key cannot be pinned on the trust commands, which refuse unknown flags.
        return [self.npm_bin, *args, f"--registry={REGISTRY}"]

    def npm(self, *args, check=True, tty=False):
        return run(self.npm_command(*args), check=check, tty=tty)

    def validate_metadata(self, metadata):
        require(isinstance(metadata, dict), "package metadata must be an object")
        require(metadata.get("name") == self.package, "package name does not match PKG_NAME")
        require(metadata.get("version") == self.version, "package version does not match PKG_VERSION")
        require(metadata.get("private") is not True, "package is private")
        repository = metadata.get("repository")
        url = repository.get("url") if isinstance(repository, dict) else repository
        require(url in (f"git+https://github.com/{self.repo}.git", f"https://github.com/{self.repo}.git",
                        f"https://github.com/{self.repo}", f"git@github.com:{self.repo}.git"),
                "package repository does not match REPO")
        config = metadata.get("publishConfig", {})
        require(isinstance(config, dict), "publishConfig must be an object")
        allowed = {"access": "public", "registry": REGISTRY, "tag": "latest"}
        require(all(key in allowed and value == allowed[key] for key, value in config.items()),
                "unsupported or conflicting publishConfig; review it explicitly")

    def effective_registry(self, key):
        # Read the configured value without overriding the key under inspection.
        value = run([self.npm_bin, "config", "get", key]).stdout.strip()
        return REGISTRY if value in EMPTY_CONFIG_VALUES else value

    def verify_registry(self):
        require(self.effective_registry("registry") == REGISTRY, "default registry is redirected; fix npm configuration")
        require(self.effective_registry(f"{self.scope}:registry") == REGISTRY,
                "scoped registry is redirected; fix npm configuration")

    def authenticate(self):
        version = run([self.npm_bin, "--version"]).stdout.strip()
        require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version), "unsupported npm version format")
        require(tuple(map(int, version.split("."))) >= MINIMUM_NPM, "npm 11.15.0 or newer required")
        user = setting("NPM_USER", r"[a-z0-9][a-z0-9._-]*")
        require(read_json(self.npm("whoami", "--json").stdout) == user, "npm account does not match NPM_USER")
        self.verify_registry()

    def source(self):
        sha = setting("SOURCE_SHA", SHA_PATTERN)
        root = run([self.git_bin, "rev-parse", "--show-toplevel"]).stdout.strip()
        require(Path(root).resolve() == Path.cwd().resolve(), "run from the target repository root")
        require(run([self.git_bin, "rev-parse", "HEAD"]).stdout.strip() == sha, "HEAD does not match SOURCE_SHA")
        require(not run([self.git_bin, "status", "--porcelain", "--untracked-files=all"]).stdout.strip(),
                "working tree must be clean; keep artifacts outside the target")

    def artifact(self):
        path = Path(setting("ARTIFACT")).resolve(strict=True)
        require(path.is_file() and path.stat().st_size <= MAX_ARTIFACT_BYTES, "artifact must be a bounded regular file")
        integrity = "sha512-" + base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode()
        require(integrity == setting("ARTIFACT_INTEGRITY"), "artifact integrity does not match reviewed bytes")
        manifests = []
        with tarfile.open(path, "r:gz") as archive:
            for index, member in enumerate(archive):
                require(index < MAX_MEMBERS, "artifact has too many entries")
                if member.name == MANIFEST_PATH:
                    require(member.isfile() and member.size <= MAX_MANIFEST_BYTES, "invalid artifact manifest")
                    with archive.extractfile(member) as stream:
                        manifests.append(read_json(stream.read().decode()))
        require(len(manifests) == 1 and manifests[0] == self.metadata, "artifact manifest does not match checkout")
        return path

    def workflow(self):
        workflow = setting("WORKFLOW_FILE", r"[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml")
        environment = setting("ENVIRONMENT", NAME_PATTERN)
        require(Path(".github/workflows", workflow).is_file(), "release workflow is missing")
        require(os.environ.get("WORKFLOW_REVIEWED") == "1", "review workflow, then set WORKFLOW_REVIEWED=1")
        return workflow, environment

    def expected_trust(self, configs):
        workflow, environment = self.workflow()
        require(isinstance(configs, list), "unexpected npm trust response schema")
        if len(configs) != 1 or not isinstance(configs[0], dict):
            return False
        config = configs[0]
        return all(config.get(key) == value for key, value in {
            "type": "github", "file": workflow, "repository": self.repo, "environment": environment,
        }.items()) and set(config.get(PERMISSIONS_FIELD, [])) == EXPECTED_TRUST_PERMISSIONS

    def trust_configs(self):
        # Colour would wrap the values this parser reads, and the interactive terminal is what lets npm run 2FA.
        return parse_trust_list(self.npm("trust", "list", self.package, "--color=false", tty=True).stdout)

    def registry_metadata(self):
        metadata = single_metadata(read_json(self.npm("view", f"{self.package}@{self.version}", "--json").stdout))
        self.validate_metadata(metadata)
        return metadata


def bootstrap(target):
    artifact = target.artifact()
    result = target.npm("view", target.package, "name", "--json", check=False)
    require(result.returncode != 0, "package already exists; bootstrap is not allowed")
    response = read_json(result.stdout)
    require(result.returncode == 1 and isinstance(response, dict)
            and isinstance(response.get("error"), dict) and response["error"].get("code") == "E404",
            "unable to establish an explicit registry not-found response")
    print("Registry returned not-found for this account; this does not reserve the name or prove ownership.")
    target.artifact()
    mutate("bootstrap-publish", target.npm_command("publish", str(artifact), "--ignore-scripts", "--access=public", "--tag=latest"))
    if os.environ.get("DRY_RUN", "0") != "1":
        # A registry read can lag the completed write; the write itself is never retried.
        metadata = read_with_retry(target.registry_metadata)
        require(metadata.get("dist", {}).get("integrity") == setting("ARTIFACT_INTEGRITY"),
                "published integrity mismatch; inspect remote state, do not retry")
        print("Published version and integrity verified. This does not prove installation or provenance.")


def configure_trust(target):
    workflow, environment = target.workflow()
    target.registry_metadata()
    configs = target.trust_configs()
    if configs:
        require(target.expected_trust(configs), "existing trusted publisher conflicts; refusing replacement")
        print("Expected trusted publisher already configured.")
        return
    mutate("configure-trust", target.npm_command("trust", "github", target.package, f"--file={workflow}",
           f"--repo={target.repo}", f"--env={environment}", "--allow-publish", "--yes"))
    if os.environ.get("DRY_RUN", "0") != "1":
        require(target.expected_trust(target.trust_configs()), "trusted publisher readback mismatch")


def verify(target):
    target.artifact()
    metadata = target.registry_metadata()
    require(metadata.get("dist", {}).get("integrity") == setting("ARTIFACT_INTEGRITY"), "registry integrity mismatch")
    access = read_json(target.npm("access", "get", "status", target.package, "--json").stdout)
    require(isinstance(access, dict) and access.get(target.package) == "public", "public package access not verified")
    require(target.expected_trust(target.trust_configs()),
            "trusted publisher does not match the expected publish grant")
    print("Package identity, integrity, public access, and trust verified; MFA, installation, and OIDC delivery remain separate checks.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=ACTIONS)
    args = parser.parse_args()
    require(os.environ.get("DRY_RUN", "0") in ("0", "1"), "DRY_RUN must be 0 or 1")
    if args.action in MUTATIONS:
        require(os.environ.get("DRY_RUN", "0") == "1" or os.environ.get("CONFIRM") == args.action,
                f"set CONFIRM={args.action}")
    target = Target()
    target.authenticate()
    if args.action in MUTATIONS:
        target.source()
    if args.action == "preflight":
        target.source()
        print("Preflight passed: local metadata, source, npm version and account. No publication authority inferred.")
    elif args.action == "bootstrap-publish":
        bootstrap(target)
    elif args.action == "configure-trust":
        configure_trust(target)
    elif args.action == "harden-publishing":
        target.registry_metadata()
        mutate(args.action, target.npm_command("access", "set", "mfa=publish", target.package))
        print("Next: verify package 2FA/token settings in npm. No MFA readback is claimed.")
    elif args.action == "verify":
        verify(target)
    elif args.action == "setup-github-release":
        setup_github(target)

if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, OSError, ValueError, tarfile.TarError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
