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

- **Publication is tag-driven CI, never local.** The tag workflow publishes
  through npm OIDC trusted publishing and the repository stores no token; the
  `scripts/npm/` helpers act only on an explicit `CONFIRM=<action>` (preview
  with `DRY_RUN=1`). Ask the maintainer instead of starting a release.
- **Release shape:** the `vX.Y.Z` tag and `package.json` `version` must match,
  and a candidate reaches `main` through a reviewed PR.
- **Commits are Conventional Commits with a scope** (`feat(catalog): …`,
  `fix(login): …`, `chore(harness): …`), signed and DCO-signed.
- **Every PR carries its `CHANGELOG.md` entry** under `## [Unreleased]`, in the
  section that fits. The entry is part of the change, not a follow-up.
- **Dependency install scripts and release age are gated in
  `pnpm-workspace.yaml`.** Ask before adding a dependency or allowlisting a
  build.
