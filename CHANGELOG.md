# Changelog

All notable changes to `@sagmans/dsh-provider-extra` are recorded in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with
the 0.x caveat [RELEASE.md](RELEASE.md) states: while at 0.x, a minor bump may
carry a breaking change, and a patch carries only fixes.

## [Unreleased]

### Added

- `tools/harness-matrix.mjs` guards the declared range, the verified releases,
  and what every harness package declares; `check`, CI, and a scheduled
  registry run all reach it. The pair drifts silently otherwise, and a drifted
  tree is what resolves a second copy of the framework beside the host's.

- `tests/harness-matrix.test.mjs` pins every rule that guard enforces, and
  `tests/config-backed-settings.spec.ts` pins extras mounting and committing on
  a harness line whose settings service publishes no section.

### Changed

- The supported harness line widens to `>=0.1.5-rc.1 <0.3.0`, and
  `dsh.compatibility.dshReleases` records the releases that passed the gates:
  `0.1.5-rc.2`, `0.1.5-rc.3`, `0.1.7-rc.2`, and `0.2.0-rc.2`. The harness
  `devDependencies` compile against `0.2.0-rc.2`, because a mounted release is
  one a range cannot reach: npm admits a prerelease only through a comparator
  naming its own `X.Y.Z` tuple. The harness peers stay `*` for the same
  reason, since a peer is resolved against the consumer's own tree and a range
  naming `0.1.5` cannot accept the `0.2.0` prerelease a profile already has.
  [RELEASE.md](RELEASE.md#harness-matrix) owns the rule.

- The settings seams follow the line they mount on. A line that publishes forms
  over each entry's own Config has no section API, so the plugin installs no
  section there and the committing Loader re-applies the entry with the new
  extras; a line with no per-namespace reader reports a route it cannot declare
  instead of failing inside a sign-in. The 0.1.5 line's section behaves as
  before. The 0.2.0 line publishes the 0.1.7 shape — forms over an entry's own
  Config, addressed by profile entry id, and no per-namespace reader — so both
  newer lines take the same branch and no further seam moved.

- The Codex fixtures and the replayed transcript follow the installed line's own
  catalog and context factory. `0.2.0-rc.2` ships a pi-ai that drops the
  `gpt-5.4` id the fixtures hardcoded and brands the normalized context a
  provider receives, so a literal that matched one line leaves the other
  unrunnable.

- A catalog profile on the 0.1.7 and 0.2.0 lines disables two more base rows:
  from 0.1.7 on, the base registers the signed-in DeepSeek account as a
  provider, so the ownership preflight reports `CATALOG_OWNER_COLLISION` until
  `llm-deepseek-account` and `deepseek-account` carry the same override the
  earlier rows do ([docs/catalog.md](docs/catalog.md)).

- `pnpm-workspace.yaml` excludes the harness vendor's scope and its model
  adapter's vendor from the release-age window, because a verified release is
  published inside that window and a harness mount resolves those same vendors'
  packages: `0.2.0-rc.2` pins `@earendil-works/pi-ai` `^0.87.1`.

- The replayed tool-result case builds its fixture through the installed line's
  own message factory, because the two lines answer a tool call differently and
  a hand-written literal replays as model-visible content on whichever line it
  does not match.
