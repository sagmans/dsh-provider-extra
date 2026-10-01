# Changelog

All notable changes to `@sagmans/dsh-provider-extra` are recorded in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with
the 0.x caveat [RELEASE.md](RELEASE.md) states: while at 0.x, a minor bump may
carry a breaking change, and a patch carries only fixes.

## [Unreleased]

### Added

- Plugin-owned OpenAI routes can select service tiers alongside Codex routes. Source-aware eligibility preserves aliases without applying paid policies to other OpenAI-compatible providers. Both streaming entry points preserve the selected tier on the wire.

## [0.7.0] - 2026-10-01

### Changed

- Agent guidance now requires signed version tags, matching GitHub releases,
  publication approval, and npm readback so published versions keep a complete
  source and release record without accidental republication.

### Added

- Explicit Auto and Fast selections appear beside effort on terminals with footer-hint support; Standard and provider default stay hidden.

- Codex service tiers can be selected per model route and saved in the owning profile Config. Auto, Standard, and Fast preserve existing authentication and transport. The provider owns its optional terminal shortcut and effort follow-up through the TUI keymap registry.

### Fixed

- Successive managed catalog changes no longer retain a retired ownership veto; active competing owners still prevent replacement.

## [0.6.0] - 2026-09-30

### Fixed

- A provider route serves the host's own model adapter instead of a private
  older copy. The `@earendil-works/pi-ai` peer admitted only `^0.85.1`, so a
  profile on the `0.2.0` line — whose harness ships `0.87.1` — resolved a second
  `0.85.1` under this plugin, and the provider built from it met the host's
  newer request vocabulary: on `0.2.0-rc.2` the first turn failed with
  `Cannot read properties of undefined (reading 'length')`. The peer now admits
  both vendor lines, and `tools/harness-matrix.mjs` refuses a peer that excludes
  the vendor a verified release ships.

### Added

- `tools/harness-matrix.mjs` guards the declared range, the verified releases,
  and what every harness package declares; `check`, CI, and a scheduled
  registry run all reach it. The pair drifts silently otherwise, and a drifted
  tree is what resolves a second copy of the framework beside the host's.

- `tests/harness-matrix.test.mjs` pins every rule that guard enforces, and
  `tests/config-backed-settings.spec.ts` pins extras mounting and committing on
  a harness line whose settings service publishes no section.

- `AGENTS.md` is added: the commands this tree runs, its file map, and the
  sharp edges a reader otherwise rediscovers. The gate order, the two sides of
  the harness matrix, the release-age exclusion a verified release needs, the
  synthetic-identifier rule the packaged examples are held to, and the rule that
  credential work stays out of the tree now read where an agent looks first
  rather than being inferred from CI and [RELEASE.md](RELEASE.md).

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

- A refused catalog declaration names the route and the model it belongs to —
  `catalog provider "<route>".models[<index>] "<model>": unknown model requires
  complete metadata: missing <field>`. A model id a newer line's vendor dropped
  takes the profile's whole model selection down, and an index into a catalog of
  dozens of entries names neither the route nor the model a reader has to repair.

- The settings seams follow the line they mount on. A line that publishes forms
  over each entry's own Config has no section API, so the plugin installs no
  section there and the committing Loader re-applies the entry with the new
  extras; a line with no per-namespace reader reports a route it cannot declare
  instead of failing inside a sign-in. The 0.1.5 line's section behaves as
  before. The 0.2.0 line publishes the 0.1.7 shape — forms over an entry's own
  Config, addressed by profile entry id, and no per-namespace reader — so both
  newer lines take the same branch and no further seam moved.

- The settings-section schemas are left to inference rather than annotated with
  the interfaces they describe. A schemastery release on a verified line widens a
  required field's output to `string | Volatile<string>`, because a loader may
  pass that field as a getter, and an annotation in the declaration's own shape
  then fails to compile on that line. The section and the entry still read the
  same declaration form, because both are built from the same schema values.

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

[Unreleased]: https://github.com/sagmans/dsh-provider-extra/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/sagmans/dsh-provider-extra/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/sagmans/dsh-provider-extra/compare/v0.5.0...v0.6.0
