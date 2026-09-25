# dsh-provider-extra

Extra provider routes for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **OpenCode Go:** sends the live conversation ID in `x-opencode-session` for routing and prompt caching.
- **OpenAI Codex:** uses a ChatGPT subscription through pi-ai's OAuth flow and the harness credential store.

Published on npm as [`@sagmans/dsh-provider-extra`](https://www.npmjs.com/package/@sagmans/dsh-provider-extra); every release carries a provenance attestation built by the tag workflow, and no npm token is stored. The code is [MIT licensed](LICENSE).

## Opt-in canonical catalog

Provider-extra remains optional. With no `catalog` Config, existing additive behavior stays unchanged.
An opted-in profile can select ordered OpenAI API, Codex, Go, Qwen Token Plan, and XAI routes.
One validated snapshot owns listings, dispatch, and `agentDefaultModel`; managed settings overlays do not apply.

Read [catalog configuration and activation](docs/catalog.md) before adoption.
The [shape example](docs/catalog-v1.example.json) validates with synthetic model identifiers and illustrative metadata, not a real provider/model selection.
Keep your model selection in your own profile Config, not in the plugin package.
For source development, use the [clone-only setup command](docs/catalog.md#clone-only-development-setup) with an explicit private catalog file.
Only the adopted profile disables competing provider/default rows. TUI and ordinary profiles require no changes.

Canonical default saves use the host profile `configEditor` when available.
Unsupported hosts reject with `CONFIG_PERSISTENCE_UNAVAILABLE`, rather than writing legacy settings.
Catalog presence does not prove endpoint availability, pricing, or metadata accuracy.

## Requirements

- Node.js 24 LTS (verified with 24.20.0).
- pnpm 11.21.0 for this repository.
- A DeepSeek Harness install on the supported line: `>=0.1.5-rc.1 <0.1.6` (verified against `0.1.5-rc.2`). The plugin declares that range as a peer dependency, so a profile resolves the harness copy it already has rather than a second framework instance.

## Install

Register the bundle in each profile you use. Web and TUI are separate compositions:

```sh
dsh plugin --profile web add @sagmans/dsh-provider-extra
dsh plugin --profile tui add @sagmans/dsh-provider-extra
```

A release of the harness CLI is installable without a launcher already on `PATH`:

```sh
pnpm dlx @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile web add @sagmans/dsh-provider-extra
```

The package declares `dsh.bundle.patch`. The CLI adds it to the profile's bundle list, and its patch loads the compiled plugin automatically. A bare `pnpm link` is not the registration procedure.

To remove it from a profile:

```sh
dsh plugin --profile web remove @sagmans/dsh-provider-extra
dsh plugin --profile tui remove @sagmans/dsh-provider-extra
```

These commands remove the profile dependency and bundle activation, not stored credentials. Restart the affected profiles after adding or removing the bundle.

### Install from source

For unreleased work, clone this repository and link the checkout instead:

```sh
git clone https://github.com/sagmans/dsh-provider-extra.git
cd dsh-provider-extra
pnpm install --frozen-lockfile
pnpm run check
dsh plugin --profile web add "link:$PWD"
dsh plugin --profile tui add "link:$PWD"
```

Rebuild with `pnpm run build` after source changes, then restart the affected profiles. The bundle uses compiled JavaScript without a TypeScript loader. Keep the linked checkout at its registered path.

### Optional profile overrides

Defaults use the `opencode-go` and `openai-codex` routes, `OPENCODE_API_KEY`, the provider sign-in command `dsh-provider-extra-login`, and the fallback session ID `dsh-provider-extra`.

To customize them, add an ID-targeted override to `$DSH_HOME/profiles/web/cordis.patch.yml`, `$DSH_HOME/profiles/tui/cordis.patch.yml`, or both. `DSH_HOME` defaults to `~/.dsh`.

```yaml
- id: dsh-provider-extra
  config:
    apiKeyEnv: OPENCODE_GO_API_KEY
    routeId: opencode-go-session
    displayName: OpenCode Go (session)
    # extraModels: [...]         # models served beside the installed catalog
    # models: [...]              # exact model IDs to serve, in this order
    # codexExtraModels: [...]    # the same two knobs for the Codex route
    # codexModels: [...]
    # codexTransport: sse        # pin the Codex transport; unset keeps pi-ai's choice
    # codexEnabled: false
    # loginCommandEnabled: false
    # loginCommandName: dsh-provider-extra-login
```

Preserve unrelated profile entries. Do not add a manual `insert` or `name`: the bundle owns plugin activation. Overrides can remain after removal without keeping the plugin active.

If you used the earlier manual registration, replace its `insert` block with an ID-targeted override before running `add`. Keep your existing `config` values. A leftover manual insert can cause duplicate loading or keep the plugin active after `remove`.

Keep `opencode-go` and `openai-codex` out of the built-in `llm-pi-ai` provider configuration. A route can have only one adapter. A duplicate produces `DUPLICATE_ADAPTER`. The plugin logs the conflict and leaves that route with its existing owner. You can choose a different `routeId`, such as `opencode-go-session`, when you need both Go routes.

Start a profile with the same harness install that owns the profiles:

```sh
dsh web
# Or:
dsh --profile tui
```

Select a model from the registered route in the model picker.

## OpenCode Go credentials and models

Store the API key through the harness credential service, using the reference named by `apiKeyEnv`. Alternatively, supply that environment variable to the harness. Do not put keys in the patch file. `baseURL` and `headers` can override the gateway endpoint and add static headers. For the standard gateway, leave them unset.

The plugin reuses `PiAiAdapter` and pi-ai's `opencode-go` catalog. It injects the routing header on both `prepareCall()` and direct stream dispatch. The request's session ID takes precedence over `fallbackSessionId` and static headers. Without a request ID or configured fallback, the plugin sends no session header.

The pinned catalog is extended with `deepseek-flash` (DeepSeek V4.1 Flash), cloned from `deepseek-v4-flash`. Add other models to the profile override without rebuilding or restarting:

```yaml
- id: dsh-provider-extra
  config:
    extraModels:
      - id: example-go-model
        name: Example Go model
        template: example-go-template
    models:
      - example-go-model
      - example-go-other-model
```

These identifiers are placeholders. Replace them with models your provider serves and templates from the installed catalog.

Each entry clones wire behavior from its template. Later entries win by ID. A catalog-owned ID is not replaced. An unknown template becomes a model diagnostic without disabling the route. The entry owns definitions for a declared exact selection.

When models or codexModels declares an exact selection, that route resolves its models against the entry's extra-model declarations. An unknown selected ID rejects the entry before the route mounts. Later settings edits cannot replace or remove those selected model definitions.

`models` serves and advertises exactly its listed IDs, in order. Leave it out to serve all resolved models.
In additive mode, an empty declaration also means no selection; managed catalog arrays never have this expansion behavior.

## Codex models

The Codex route serves pi-ai's installed `openai-codex` catalog for the signed-in subscription. Extend it the same way when the subscription serves an ID the installed catalog predates:

```yaml
- id: dsh-provider-extra
  config:
    codexExtraModels:
      - id: example-codex-model
        name: Example Codex model
        template: example-codex-template
    codexModels:
      - example-codex-model
      - example-codex-other-model
```

These identifiers are placeholders, not model recommendations.

Unlike the Go route, these entries must name their `template`: Codex ships no default sibling, so a declaration that names none is reported as a model diagnostic instead of cloned from another vendor's catalog. Later entries win by ID, a catalog-owned ID is not replaced, and an unknown template becomes a diagnostic without disabling the route.

Routes without models or codexModels continue to read extraModels or codexExtraModels from the settings section on each operation. Settings additions, metadata changes, and removals reach those unselected routes without a restart. A declared selection keeps its entry-owned model definitions instead.

`codexTransport` pins the transport pi-ai uses for this route: `sse`, `websocket`, `websocket-cached`, or `auto`. Leave it out and pi-ai chooses, which on a network that never lets the subscription's websocket continue past the first answer leaves the reply printed and the process waiting; pin `sse` there.

## Provider sign-in

Sign in from the profile you are already using. The plugin registers a command in the harness command palette.
In additive mode, it offers providers with an installed interactive login.
In managed mode, it offers only the routes and authentication methods selected by `catalog`.

```text
/dsh-provider-extra-login [<id> [oauth|key] | status]
```

Omit the ID to pick a provider. Set `loginCommandName` to rename the command.
Set `loginCommandEnabled: false` to disable it in either mode.
The command needs a command registry and a session UI to ask sign-in questions.

Managed IDs are exactly the `Config.catalog` route IDs, shown with their configured names.
Additive IDs remain installed source provider IDs, including `opencode-go` when its configured route is aliased.
With no method word, the command uses the only available method, or OAuth first when both are available.
Use `oauth` or `key` to select a method explicitly.
A managed `apiKeyRef` route offers only key entry, including XAI.

Managed sign-in writes the configured credential reference or source record.
It never declares routes or changes Config, defaults, settings, or membership.
Additive sign-in can declare an undeclared provider in `llm-pi-ai` settings.
Credentials serve the next request without a restart.

Missing or read-only credential stores refuse sign-in before any secret or OAuth prompt.
API-key entry uses a secret-marked question and verifies the pending key before storage.
A zero-model key route fails with `cannot verify this API key: no models are available for provider <route-id>`.
That failure stores nothing. Success requires a readback from the effective credential store.

Managed status prints `API key <ref> (not set|set from <source>)` for reference-backed routes.
It never substitutes a provider record for an unresolved reference.
Source-record mode reports `not signed in` or `signed in (api_key|oauth)` from `llm-pi-ai:<credentialProvider>`.
Status and OAuth persistence do not check endpoint availability or account entitlement.

Without a command palette — a headless composition, or a sign-in for a server you are not attached to — use the shipped bin instead. It signs into the Codex route only, and needs the same `DSH_HOME` as the harness plus a profile that has booted at least once, because that is what installs the tree the bin resolves the harness packages through:

```sh
"$DSH_HOME/profiles/web/node_modules/.bin/dsh-provider-extra-login"
# If the server uses a non-default credentials file:
"$DSH_HOME/profiles/web/node_modules/.bin/dsh-provider-extra-login" --credentials-path /absolute/path/to/.credentials.yaml
```

From a source checkout, `pnpm codex:login` runs the same entry point through the TypeScript loader.

Choose device-code login for a headless host or browser login for a desktop. Follow the URL and prompts printed by pi-ai. The browser callback uses `localhost:1455`. The prompt also accepts a pasted redirect URL.

The grant is stored in `$DSH_HOME/.credentials.yaml` by default. Writes use the harness document lock, and the running adapter reads the grant on the next request. Never commit the grant or include it in a bug report. Renaming `codexRouteId` changes the credential address, so keep the default unless a separate grant is intentional. Set `codexEnabled: false` to disable this route.

## Development and verification

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm audit --audit-level high
```

`check` runs type checking, source tests, the build, integration tests, release guards, and the package smoke.
Package checks reject non-synthetic catalog/model declarations in shipped configuration and documentation.
Development setup tests use synthetic credentials-free profiles; the setup helper stays outside the npm package. The plain-Node smoke test mounts both compiled routes in the real Cordis/LLM runtime. Two CLI tests exercise add, repeated add, profile overrides, and remove in disposable web/TUI profiles; they drive the registry CLI this repository develops against (`@deepseek-ai/dsh@0.1.5-rc.2`), so no harness checkout is needed.

Tests use a local mock gateway or seeded grants. They require no API key, OAuth login, or paid provider requests.

CI installs from the registry with read-only permissions and no account credentials, verifies dependency signatures and attestations, and runs the same checks. New dependency releases must be at least seven days old, and `pnpm-workspace.yaml` limits which lifecycle scripts may run.

The package smoke test does not prove a real account can authenticate or a remote provider is available. To verify those, install a candidate into a profile built on the supported harness line and send one message through each configured route.

Before sending a pull request, run the checks and describe the behavior changed. Report security problems privately to the repository maintainer, not in public issues. Remove keys, grants, conversation content, and machine-specific paths from shared logs.

## Releasing

Published artefacts carry a provenance attestation, which only a CI provider can issue, so releases ship from the tag workflow rather than a laptop.

1. Bump `version` in `package.json`, land it on `main` through a reviewed PR, and wait for CI to pass on the merged SHA.
2. Tag that SHA with a signed tag and push it. The tag ruleset admits repository admins only.
3. [`.github/workflows/release.yml`](.github/workflows/release.yml) re-runs the checks and the package smoke; the publish job then waits for a maintainer's approval on the `npm-release` environment before it publishes with OIDC trusted publishing and automatic provenance.

The workflow stores no npm token: the registry trusts `release.yml` on the `npm-release` environment, and [`scripts/npm/release.py`](scripts/npm/release.py) creates both the environment and that trust. The full runbook is [RELEASE.md](RELEASE.md).

## License

MIT
