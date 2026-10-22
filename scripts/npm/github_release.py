"""Create-only GitHub controls; conflicting existing policy needs human review."""

import json
import os

from execution import mutate, read_json, require, run, setting

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


def setup_github(target):
    _, environment = target.workflow()
    owner = setting("RELEASE_OWNER", OWNER_PATTERN)
    tag = setting("TAG_PATTERN", TAG_PATTERN)
    require(".." not in tag and "//" not in tag and not tag.startswith("/"), "invalid TAG_PATTERN")
    ruleset_name = setting("RULESET_NAME", SAFE_NAME)
    run([target.gh_bin, "auth", "status", "--hostname", HOST])

    def command(endpoint, *args):
        return [target.gh_bin, "api", "--hostname", HOST, endpoint, *args]

    def get(endpoint, *, missing=False):
        result = run(command(endpoint), check=False)
        if missing and result.returncode != 0 and "(HTTP 404)" in result.stderr:
            return None
        require(result.returncode == 0, "GitHub inspection failed; no absence inferred")
        return read_json(result.stdout)

    def pages(endpoint, key=None):
        value = read_json(run(command(endpoint, "--paginate", "--slurp")).stdout)
        require(isinstance(value, list), "unexpected GitHub pagination response")
        items = []
        for page in value:
            entries = page.get(key) if key and isinstance(page, dict) else page
            require(isinstance(entries, list) and all(isinstance(item, dict) for item in entries),
                    "unexpected GitHub list response")
            items.extend(entries)
        return items

    def change(endpoint, method, payload):
        mutate(ACTION, command(endpoint, "--method", method, "--input", "-"), data=json.dumps(payload, sort_keys=True))

    repo = get(f"repos/{target.repo}")
    require(isinstance(repo, dict) and repo.get("full_name") == target.repo
            and isinstance(repo.get("permissions"), dict) and repo["permissions"].get("admin") is True,
            "expected repository administration access not verified")
    user = get(f"users/{owner}")
    require(isinstance(user, dict) and user.get("login", "").lower() == owner.lower()
            and type(user.get("id")) is int and user["id"] > 0, "release owner identity not verified")
    owner_id = user["id"]
    environment_endpoint = f"repos/{target.repo}/environments/{environment}"
    policies_endpoint = f"{environment_endpoint}/deployment-branch-policies"
    rulesets_endpoint = f"repos/{target.repo}/rulesets"
    branch_policy = {"protected_branches": False, "custom_branch_policies": True}
    environment_payload = {
        "can_admins_bypass": False,
        "deployment_branch_policy": branch_policy,
    }
    ruleset_payload = {
        "name": ruleset_name, "target": "tag", "enforcement": "active",
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

    def inspect():
        current = get(environment_endpoint, missing=True)
        policies = []
        if current is not None:
            require(isinstance(current, dict) and current.get("can_admins_bypass") is False
                    and current.get("deployment_branch_policy") == branch_policy,
                    "existing environment conflicts; refusing overwrite")
            protections = current.get("protection_rules", [])
            require(isinstance(protections, list) and all(isinstance(rule, dict) for rule in protections),
                    "unexpected environment protections")
            require(all(rule.get("type") in ENVIRONMENT_PROTECTIONS for rule in protections),
                    "existing environment protections conflict; refusing overwrite")
            policies = pages(policies_endpoint, "branch_policies")
            require(len(policies) <= 1 and all(policy.get("name") == tag and policy.get("type") == "tag" for policy in policies),
                    "existing deployment policies conflict; branch and tag policies are distinct")
        matches = [item for item in pages(rulesets_endpoint) if item.get("name") == ruleset_name]
        require(len(matches) <= 1, "multiple named rulesets conflict")
        if matches:
            entry = matches[0]
            require(entry.get("source_type") == "Repository" and type(entry.get("id")) is int,
                    "inherited or malformed ruleset conflicts")
            details = get(f"{rulesets_endpoint}/{entry['id']}")
            require(isinstance(details, dict) and all(details.get(key) == value for key, value in ruleset_payload.items()),
                    "existing ruleset conflicts; refusing overwrite")
        return current, policies, matches

    current, policies, matches = inspect()
    if current is None:
        change(environment_endpoint, "PUT", environment_payload)
    if not policies:
        change(policies_endpoint, "POST", {"name": tag, "type": "tag"})
    if not matches:
        change(rulesets_endpoint, "POST", ruleset_payload)
    if os.environ.get("DRY_RUN", "0") == "1":
        print("GitHub preview only; no controls changed.")
    else:
        current, policies, matches = inspect()
        require(current is not None and len(policies) == 1 and len(matches) == 1,
                "GitHub readback incomplete; inspect partial state before retrying")
        print("GitHub environment, tag policy, and named ruleset readback verified.")
