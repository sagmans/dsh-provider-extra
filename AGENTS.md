# AGENTS.md

`@sagmans/dsh-provider-extra` is a Cordis plugin for DeepSeek Harness: it adds
the OpenCode Go route (stamping `x-opencode-session` from the live session) and
the OpenAI Codex route (a ChatGPT subscription through pi-ai's OAuth), and an
opted-in profile can hand it the whole model catalog. ESM TypeScript (strict),
Node >= 24, pnpm. Behaviour and install: [README.md](README.md). Catalog
configuration: [docs/catalog.md](docs/catalog.md). Publication:
[RELEASE.md](RELEASE.md). History: [CHANGELOG.md](CHANGELOG.md).

## Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install --frozen-lockfile` |
| Typecheck | `pnpm run typecheck` |
| Unit and integration specs | `pnpm test` |
| Built-output tests | `pnpm run build && pnpm run test:build` |
| Release-helper guards (python3 >= 3.11) | `pnpm test:release` |
| Tarball inventory check | `pnpm run pack-smoke` |
| Harness matrix guard | `pnpm run matrix` |
| Everything above, in CI order | `pnpm run check` |
| Adopt the catalog in a clone | `pnpm run catalog:setup` |
| Sign in to Codex from a checkout | `pnpm run codex:login` |

`.github/workflows/check.yml` is the gate; `.github/workflows/harness-matrix.yml`
reads the registry daily. Neither proves a real account authenticates — dogfood a
packed candidate in a cloned home (see [README.md](README.md#development-and-verification)).

## Map

- `src/index.ts` mounts the additive routes, `src/catalog-runtime.ts` the
  catalog-owned composition that replaces every competing provider row.
- `src/catalog*.ts` compile, validate, and resolve the catalog;
  `src/opencode-go.ts`, `src/codex.ts`, and `src/extra-models.ts` build each
  route's pi-ai profile; `src/login*.ts` own the sign-in command, its
  questions, and the credential it writes.
- `tests/*.spec.ts` drive the TypeScript sources, `tests/*.test.mjs` the built
  package; `tests/release/test_release.py` guards `scripts/npm/release.py`.
- `tools/harness-matrix.mjs` guards the declared harness range and verified
  releases, `tools/catalog-artifact-policy.mjs` the packaged examples,
  `tools/pack-smoke.mjs` the tarball, and `tools/catalog-setup.mjs` a clone.
- `dist/` is build output and is never edited by hand.

## Sharp edges

**The harness matrix has two sides.** `dsh.compatibility.dsh` is the range a
profile and the peers accept; `dsh.compatibility.dshReleases` lists what the
gates ran against; the harness `devDependencies` compile against exactly one of
those. The harness peers stay `*` on purpose — npm resolves a peer against the
consumer's tree, and a peer range cannot span two prerelease lines — while a
mounted package names the range or one verified release.
`node tools/harness-matrix.mjs` fails when the three disagree, and
[RELEASE.md](RELEASE.md#harness-matrix) owns the bump.

**A verified release is published inside the release-age window**, so
`pnpm-workspace.yaml` excludes the vendor's scope from it; a harness mount also
resolves that same vendor's packages, which the exclusion has to cover.

**The packaged examples are checked for synthetic identifiers.** Every catalog
and model declaration in shipped configuration, examples, and documentation
must use `example-*` ids; a real model name in the package fails the gate.

**Credential work stays out of the tree and out of a live home.** Keys and Codex
grants belong in `$DSH_HOME/.credentials.yaml`; dogfood in a cloned home, never
`~/.dsh`. The API-key route accepts an unset reference and fails at request
time by design, so a green mount proves nothing about a credential.

## Boundaries

- **Release and publication:** follow the signed-tag, approval, and readback
  sequence below and the gates in [RELEASE.md](RELEASE.md).
- **Commits are Conventional Commits with a scope** (`feat(catalog): …`,
  `fix(login): …`, `chore(harness): …`), signed and DCO-signed.
- **Every PR carries its `CHANGELOG.md` entry** under `## [Unreleased]`, in the
  section that fits. The entry is part of the change, not a follow-up.
- **Dependency install scripts and release age are gated in
  `pnpm-workspace.yaml`.** Ask before adding a dependency or allowlisting a
  build.

## Release and publication

Read [RELEASE.md](RELEASE.md) before preparing a version, pushing a release tag,
publishing, or repairing a release record. Shipping a documentation or code PR
is not approval to publish. Require explicit maintainer approval for publication
and each remote release action; never publish on your own initiative.

1. Land the candidate through a reviewed PR to `main`. Match `package.json`
   `version`, the `vX.Y.Z` tag, and the versioned `CHANGELOG.md` entry.
   Pass the release gates in `RELEASE.md` on the exact merged commit.
2. Create an annotated, signed tag on that commit:
   `git tag -s -a "vX.Y.Z" -m "vX.Y.Z" <merged-sha>`.
   Verify it with `git verify-tag "vX.Y.Z"`. Never use a lightweight or unsigned
   release tag; require GitHub to verify the signature after the approved push.
3. Push only that tag with `git push origin "vX.Y.Z"` after approval.
   `.github/workflows/release.yml` verifies the tag and publishes through npm
   OIDC trusted publishing after the `npm-release` environment approval.
   Wait for success; never substitute a local `npm publish`. The documented
   first-publication bootstrap is a maintainer-only exception, not a retry path.
4. After publication succeeds, create the GitHub release from the existing tag:
   `gh release create "vX.Y.Z" --verify-tag --title "vX.Y.Z" --notes-file <notes-file>`.
   Use that version's changelog entry as notes. Set `--latest=false` when filling
   an older release so it does not replace the current latest release.
5. Read back the npm version, tarball integrity and available provenance, the
   remote tag's verified signature and source commit, and the published GitHub
   release for the same version. A green workflow alone is not completion:
   every npm version requires its own signed tag and GitHub release record.

Published versions and tags are immutable. Never delete, move, or re-sign an
existing release tag, and never republish or unpublish an existing npm version.
For a missing GitHub release, verify the existing signed tag and create only its
release record with `--verify-tag`; do not push another tag or retry publication.
If a tag or signature is missing or invalid, stop and ask the maintainer; do not
invent a source commit from current `main`. Forward-fix broken packages as
`RELEASE.md` directs. Helper mutations require `CONFIRM=<action>`; preview
with `DRY_RUN=1`.
