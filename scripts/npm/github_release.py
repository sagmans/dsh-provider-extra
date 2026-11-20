"""Create-only GitHub controls; conflicting existing policy needs human review."""

import json
import os
from dataclasses import dataclass

from execution import ReleaseError, mutate, read_json, require, run, setting

ACTION = "setup-github-release"
HOST = "github.com"
ADMIN_ROLE_ID = 5
SAFE_NAME = r"[A-Za-z0-9][A-Za-z0-9._-]*"
OWNER_PATTERN = r"[A-Za-z0-9][A-Za-z0-9-]{0,38}"
# A signed `v*` tag push by an admin is the release approval, so the environment
# carries only the tag deployment policy; any other protection, such as a
# required reviewer or wait timer, is drift from that decision.
ENVIRONMENT_PROTECTIONS = ("branch_policy",)
TAG_PATTERN = r"[A-Za-z0-9._/-]+\*?"


def _gh_command(gh_bin, endpoint, *args):
    """Build a pinned github.com API command so calls never drift to another host."""
    return [gh_bin, "api", "--hostname", HOST, endpoint, *args]


def _gh_get(gh_bin, endpoint, *, missing=False):
    """Fail closed on API failures so auth or outage errors never masquerade as absence."""
    result = run(_gh_command(gh_bin, endpoint), check=False)
    if missing and result.returncode != 0 and "(HTTP 404)" in result.stderr:
        return None
    require(result.returncode == 0, "GitHub inspection failed; no absence inferred")
    return read_json(result.stdout)


def _gh_pages(gh_bin, endpoint, key=None):
    """Collect every response page so conflicting controls on later pages cannot be missed."""
    value = read_json(run(_gh_command(gh_bin, endpoint, "--paginate", "--slurp")).stdout)
    require(isinstance(value, list), "unexpected GitHub pagination response")
    items: list[dict[str, object]] = []
    for page in value:
        entries = page.get(key) if key and isinstance(page, dict) else page
        if not isinstance(entries, list) or not all(isinstance(item, dict) for item in entries):
            raise ReleaseError("unexpected GitHub list response")
        items.extend(entries)
    return items


def _verify_actor_and_repo(target, owner):
    """Confirm admin authority and resolve the release owner's immutable numeric id."""
    repo = _gh_get(target.gh_bin, f"repos/{target.repo}")
    require(
        isinstance(repo, dict)
        and repo.get("full_name") == target.repo
        and isinstance(repo.get("permissions"), dict)
        and repo["permissions"].get("admin") is True,
        "expected repository administration access not verified",
    )
    user = _gh_get(target.gh_bin, f"users/{owner}")
    require(
        isinstance(user, dict)
        and user.get("login", "").lower() == owner.lower()
        and type(user.get("id")) is int
        and user["id"] > 0,
        "release owner identity not verified",
    )
    return user["id"]


@dataclass(frozen=True)
class _GitHubControls:
    """Bundle GitHub API endpoints and policy payloads so pre-write and readback checks share one contract."""

    gh_bin: str
    environment_endpoint: str
    policies_endpoint: str
    rulesets_endpoint: str
    branch_policy: dict[str, bool]
    tag: str
    ruleset_name: str
    ruleset_payload: dict[str, object]

    def change(self, endpoint, method, payload):
        """Route mutations through the preview-aware runner with canonical JSON serialization."""
        mutate(
            ACTION,
            _gh_command(self.gh_bin, endpoint, "--method", method, "--input", "-"),
            data=json.dumps(payload, sort_keys=True),
        )

    def inspect_environment(self):
        """Verify any existing environment and tag policy match our contract without overwriting drift."""
        current = _gh_get(self.gh_bin, self.environment_endpoint, missing=True)
        policies: list[dict[str, object]] = []
        if current is not None:
            require(
                isinstance(current, dict)
                and current.get("can_admins_bypass") is False
                and current.get("deployment_branch_policy") == self.branch_policy,
                "existing environment conflicts; refusing overwrite",
            )
            protections = current.get("protection_rules", [])
            require(
                isinstance(protections, list) and all(isinstance(rule, dict) for rule in protections),
                "unexpected environment protections",
            )
            require(
                all(rule.get("type") in ENVIRONMENT_PROTECTIONS for rule in protections),
                "existing environment protections conflict; refusing overwrite",
            )
            policies = _gh_pages(self.gh_bin, self.policies_endpoint, "branch_policies")
            require(
                len(policies) <= 1
                and all(policy.get("name") == self.tag and policy.get("type") == "tag" for policy in policies),
                "existing deployment policies conflict; branch and tag policies are distinct",
            )
        return current, policies

    def inspect_ruleset(self):
        """Confirm any matching repository ruleset is exact so inherited or drifted rules are not overwritten."""
        matches = [
            item for item in _gh_pages(self.gh_bin, self.rulesets_endpoint) if item.get("name") == self.ruleset_name
        ]
        require(len(matches) <= 1, "multiple named rulesets conflict")
        if matches:
            entry = matches[0]
            require(
                entry.get("source_type") == "Repository" and type(entry.get("id")) is int,
                "inherited or malformed ruleset conflicts",
            )
            details = _gh_get(self.gh_bin, f"{self.rulesets_endpoint}/{entry['id']}")
            require(
                isinstance(details, dict)
                and all(details.get(key) == value for key, value in self.ruleset_payload.items()),
                "existing ruleset conflicts; refusing overwrite",
            )
        return matches


def setup_github(target):
    """Ensure the create-only GitHub environment, tag policy, and admin-only tag ruleset exist."""
    _, environment = target.workflow()
    owner = setting("RELEASE_OWNER", OWNER_PATTERN)
    tag = setting("TAG_PATTERN", TAG_PATTERN)
    require(".." not in tag and "//" not in tag and not tag.startswith("/"), "invalid TAG_PATTERN")
    ruleset_name = setting("RULESET_NAME", SAFE_NAME)
    run([target.gh_bin, "auth", "status", "--hostname", HOST])

    owner_id = _verify_actor_and_repo(target, owner)
    environment_endpoint = f"repos/{target.repo}/environments/{environment}"
    branch_policy = {"protected_branches": False, "custom_branch_policies": True}
    environment_payload = {
        "can_admins_bypass": False,
        "deployment_branch_policy": branch_policy,
    }
    ruleset_payload: dict[str, object] = {
        "name": ruleset_name,
        "target": "tag",
        "enforcement": "active",
        "conditions": {"ref_name": {"include": [f"refs/tags/{tag}"], "exclude": []}},
        "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}],
        # A role-based bypass does not survive a change of repository owner: the
        # control then blocks even the release owner, so the owner is named
        # directly as well and the gate keeps admitting a human.
        "bypass_actors": [
            {"actor_id": ADMIN_ROLE_ID, "actor_type": "RepositoryRole", "bypass_mode": "always"},
            {"actor_id": owner_id, "actor_type": "User", "bypass_mode": "always"},
        ],
    }
    controls = _GitHubControls(
        gh_bin=target.gh_bin,
        environment_endpoint=environment_endpoint,
        policies_endpoint=f"{environment_endpoint}/deployment-branch-policies",
        rulesets_endpoint=f"repos/{target.repo}/rulesets",
        branch_policy=branch_policy,
        tag=tag,
        ruleset_name=ruleset_name,
        ruleset_payload=ruleset_payload,
    )

    current, policies = controls.inspect_environment()
    matches = controls.inspect_ruleset()
    if current is None:
        controls.change(controls.environment_endpoint, "PUT", environment_payload)
    if not policies:
        controls.change(controls.policies_endpoint, "POST", {"name": tag, "type": "tag"})
    if not matches:
        controls.change(controls.rulesets_endpoint, "POST", ruleset_payload)
    if os.environ.get("DRY_RUN", "0") == "1":
        print("GitHub preview only; no controls changed.")
    else:
        current, policies = controls.inspect_environment()
        matches = controls.inspect_ruleset()
        require(
            current is not None and len(policies) == 1 and len(matches) == 1,
            "GitHub readback incomplete; inspect partial state before retrying",
        )
        print("GitHub environment, tag policy, and named ruleset readback verified.")
