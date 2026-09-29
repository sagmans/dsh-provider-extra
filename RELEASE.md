# Release Policy

Applies to maintainers. Current release owner: repository owner ([`LICENSE`](LICENSE)).

## Versioning

[SemVer](https://semver.org). While at 0.x, minor bumps may contain breaking changes; patch bumps are fixes only. The git tag (`vX.Y.Z`) and `package.json` `version` must always match. The tag workflow fails before publish when they do not.

## Gates — all required before tagging

1. Candidate lands on `main` through a reviewed PR (squash merge).
2. `verify` CI green on the exact merged SHA.
3. Locally on that SHA: `pnpm typecheck`, `pnpm test`, `node tools/harness-matrix.mjs`, `pnpm run build`, `pnpm run test:build`, `pnpm test:release`, `npm audit signatures`, `pnpm audit --audit-level high`, and `node tools/pack-smoke.mjs`.
4. Dogfooding: install the packed candidate into a plugin profile whose harness is a verified release (`>=0.1.5-rc.1 <0.3.0`) and drive a real session through **both** routes — OpenCode Go with a stored key, OpenAI Codex after `dsh-provider-extra-login`. Unit tests do not prove a real account authenticates or a remote gateway accepts the session header.
5. README accuracy pass: every documented command, profile path, and credential reference still behaves as written.
6. A published npm version is immutable. A broken release is forward-fixed, never unpublished (see [Rollback](#rollback)).

## Harness matrix

The plugin mounts harness packages and peers on harness modules, so `dsh.compatibility.dsh` is the range its peers and a profile accept, and `dsh.compatibility.dshReleases` lists the releases that passed the gates. The harness peers themselves stay `*`: npm resolves a peer against the consumer's own tree, and a peer range cannot span two prerelease lines — npm admits a prerelease only through a comparator naming its own `X.Y.Z` tuple, so `>=0.1.5-rc.1 <0.2.0` reaches `0.1.5-rc.3` and never a `0.1.7` prerelease, which resolves a second framework copy beside the version the profile already has. The runtime gates a row on those same peer ranges before it mounts one — `@deepseek-ai/dsh-app-boot` reads them with `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` and reports the row incompatible when none admits the host — which is the second reason `*` is the only shape that serves every line. A mounted package, by contrast, either accepts that range or names one verified release, the way the harness's own bundles pin.

The model adapter's vendor is the one peer whose range is not `*`: this plugin builds a provider out of it and hands that object to the host's adapter seam, so a peer that excludes the vendor a served line pins resolves a private older copy under the plugin and fails the first turn against the host's newer request shapes (`0.2.0-rc.2` with `0.85.1`, fixed by admitting `^0.87.1`). Its range names every vendor line the verified releases ship; `tools/harness-matrix.mjs` reads them from `LINE_VENDOR_PINS` and refuses a peer that cannot admit one.

`node tools/harness-matrix.mjs` guards the matrix offline and `check` runs it: every verified release lies inside the range, every mounted package accepts the range or names a verified release, every harness peer stays open or names one of those, every aliased install names one, and the harness devDependencies compile against exactly one verified release. [`.github/workflows/harness-matrix.yml`](.github/workflows/harness-matrix.yml) runs the same tool with `--check-registry` daily and fails when `@deepseek-ai/dsh@latest` is not a verified release.

That failure is the matrix bump, and it is a release-sized change:

1. Run `node tools/harness-matrix.mjs --check-registry` to read the release the harness now serves as `latest`.
2. Add it to `dsh.compatibility.dshReleases`, raise the `@deepseek-ai/dsh-*` `devDependencies` to it, and raise every mounted package and aliased install that names a release to it as well; `dsh.compatibility.dsh` widens only when the whole line's gates pass, and a package that serves the older line stays behind.
3. `pnpm install`, then run every gate above. The vendor's scope is excluded from the release-age window in `pnpm-workspace.yaml`, because a verified release is published inside that window and the mount resolves the same vendor's packages.
4. Dogfood a real session against the new release before it ships: install the packed candidate into a cloned home's profile and drive a real surface through the routes this plugin owns.
5. Land the bump through a reviewed PR and ship it with the next patch release.

## Release identity and authority

Static identity lives in [`scripts/npm/target.env`](scripts/npm/target.env). Load it before every helper action:

```sh
set -a; . scripts/npm/target.env; set +a
```

Per-release values are exported for one release only and are never stored in the repository: `PKG_VERSION`, `SOURCE_SHA`, `ARTIFACT`, `ARTIFACT_INTEGRITY`.

The helper is [`scripts/npm/release.py`](scripts/npm/release.py); [`pnpm test:release`](tests/release) exercises its guards through synthetic CLIs, and CI runs that suite on every change. No helper action writes to npm or GitHub without its own `CONFIRM=<action>` value. `DRY_RUN=1` prints the exact mutation instead of running it. Reading this policy, passing preflight, or exporting a variable is not approval.

The helper rejects a redirected registry before it acts: it reads the effective `registry` and `@sagmans:registry` configuration and fails closed unless both resolve to `https://registry.npmjs.org/`. The trust commands refuse unknown flags, so that check replaces pinning the scoped key on the command line.

Trust reads need an interactive terminal. npm starts its browser two-factor approval only when stdin and stdout are terminals, so the helper gives those reads a pseudo-terminal and mirrors the approval URL to stderr; approve it in a browser when the helper pauses.

Prerequisites: `python3` 3.11 or newer, npm 11.15.0 or newer, authenticated `npm` and `gh` CLIs, repository administration access, and a clean checkout.

## First publication (`v0.1.0` only)

npm requires a package to exist before trusted publishing can be configured, so the `v0.1.0` tag verifies but skips the publish job in [`release.yml`](.github/workflows/release.yml). The release owner publishes that version by hand from a clean checkout of the exact signed tag. Keep the reviewed artefact outside the checkout and unchanged until publication completes.

```sh
set -a; . scripts/npm/target.env; set +a
export PKG_VERSION='0.1.0'
export SOURCE_SHA="$(git rev-parse HEAD)"
export ARTIFACT_DIR='/tmp/dsh-provider-extra-release'
mkdir -p "${ARTIFACT_DIR}"
# npm, not pnpm: the helper compares the packed manifest with the checkout
# byte-for-byte, and only npm's tarball embeds the manifest unchanged.
npm pack --pack-destination "${ARTIFACT_DIR}"
export ARTIFACT="${ARTIFACT_DIR}/sagmans-dsh-provider-extra-${PKG_VERSION}.tgz"
export ARTIFACT_INTEGRITY="sha512-$(openssl dgst -sha512 -binary "${ARTIFACT}" | openssl base64 -A)"
```

Review the packed inventory and confirm the artefact came from the reviewed SHA. Then preview and publish:

```sh
DRY_RUN=1 python3 scripts/npm/release.py preflight
DRY_RUN=1 python3 scripts/npm/release.py bootstrap-publish
CONFIRM=bootstrap-publish python3 scripts/npm/release.py bootstrap-publish
```

`bootstrap-publish` refuses an existing package, publishes the reviewed tarball with lifecycle scripts disabled, and verifies the delivered integrity. Local publication cannot generate provenance; provenance begins with the OIDC releases that follow. The registry can take minutes to serve a version it has already accepted — observed at about six minutes for the tarball — so the helper repeats a read that did not complete, then reports; a read that answered with the wrong identity is not repeated, and a publication is never retried. If the result is ambiguous, inspect the registry before any retry.

## Recurring release controls (once, after the bootstrap)

Each remote action needs its own approval. Preview first, then confirm:

```sh
DRY_RUN=1 python3 scripts/npm/release.py setup-github-release
CONFIRM=setup-github-release python3 scripts/npm/release.py setup-github-release

DRY_RUN=1 python3 scripts/npm/release.py configure-trust
CONFIRM=configure-trust python3 scripts/npm/release.py configure-trust

DRY_RUN=1 python3 scripts/npm/release.py harden-publishing
CONFIRM=harden-publishing python3 scripts/npm/release.py harden-publishing
```

- `setup-github-release` creates the approval-gated `npm-release` environment and an admin-only `v*` tag ruleset. It refuses to overwrite conflicting existing controls. GitHub drops role-based bypass actors when a repository changes owner, which leaves tag creation closed even to the release owner, so after a move confirm the ruleset still admits a human before tagging.
- `configure-trust` binds publication to this repository's `release.yml` on the `npm-release` environment. The registry answers a publish grant with stage publish included, so that pair is the accepted configuration; a stage-only grant carries no publish authority and is refused, as is any conflicting existing trust.
- `harden-publishing` requires two-factor authentication for publication and disallows traditional tokens, so the OIDC flow is the only publish path. Confirm the package settings on npmjs.com afterwards; the helper does not claim MFA readback.

Then verify identity, integrity, public access, and the exact trust. The trust read asks for browser approval, so run it from an interactive terminal:

```sh
DRY_RUN=1 python3 scripts/npm/release.py verify
python3 scripts/npm/release.py verify
```

## Tagging a release

Draft the GitHub release notes against the candidate SHA before tagging. Tag creation for `v*` is restricted to repository admins by the ruleset above.

```sh
git tag -s -a "v${PKG_VERSION}" -m "v${PKG_VERSION}" <merged-sha>
git push origin "v${PKG_VERSION}"
```

The tag push runs `release.yml`: it re-verifies the candidate, then the publish job waits for the release owner's approval on the `npm-release` environment before publishing through OIDC trusted publishing with automatic provenance. Create the GitHub release from the tag using the drafted notes after publication succeeds.

## Rollback

- **Bad tag or release:** keep the signed tag, source SHA, and GitHub release record intact. npm versions are immutable, and deleting references breaks the source chain. Deprecate instead, mark the GitHub release as broken, and ship a patch release:
  ```sh
  npm deprecate "@sagmans/dsh-provider-extra@<version>" "<reason>; use @sagmans/dsh-provider-extra@<replacement> instead"
  ```
- **Bad route behaviour:** patch release; never disable a running profile or rewrite a user's stored conversations or credentials.
- **Broken trust configuration:** fix it with `configure-trust` after inspecting `npm trust list`; revoking credentials or changing account security needs separate approval.
