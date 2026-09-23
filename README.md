# dsh-provider-extra

Extra provider routes for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **OpenCode Go:** sends the live conversation ID in `x-opencode-session` for routing and prompt caching.
- **OpenAI Codex:** uses a ChatGPT subscription through pi-ai's OAuth flow and the harness credential store.

Published on npm as [`@sagmans/dsh-provider-extra`](https://www.npmjs.com/package/@sagmans/dsh-provider-extra); every release carries a provenance attestation built by the tag workflow, and no npm token is stored. The code is [MIT licensed](LICENSE).

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

The pinned catalog is extended with `deepseek-flash` (DeepSeek V4.1 Flash), cloned from `deepseek-v4-flash`. Add other models in `$DSH_HOME/settings.yaml` without rebuilding or restarting:

```yaml
dsh-provider-extra:
  extraModels:
    - id: deepseek-flash
      name: DeepSeek V4.1 Flash
      template: deepseek-v4-flash
```

Each entry clones wire behavior from its template. Later entries win by ID. A catalog-owned ID is not replaced. An unknown template becomes a model diagnostic without disabling the route.

## Codex models

The Codex route serves pi-ai's installed `openai-codex` catalog for the signed-in subscription. Extend it the same way when the subscription serves an ID the installed catalog predates:

```yaml
dsh-provider-extra:
  codexExtraModels:
    - id: gpt-6-luna
      name: GPT-6 Luna
      template: gpt-5.6-luna
```

Unlike the Go route, these entries must name their `template`: Codex ships no default sibling, so a declaration that names none is reported as a model diagnostic instead of cloned from another vendor's catalog. Later entries win by ID, a catalog-owned ID is not replaced, and an unknown template becomes a diagnostic without disabling the route. Both settings sections are read per request, so a committed change reaches the next turn with no restart.

## Provider sign-in

Sign in from the profile you are already using: the plugin registers a command in the harness command palette, and it reaches every provider the installed pi-ai catalog ships a login for — the two routes here, and core's own.

```text
/dsh-provider-extra-login                # pick a provider, then run its sign-in
/dsh-provider-extra-login openai-codex   # skip the picker: that provider's subscription login
/dsh-provider-extra-login anthropic key  # that provider's API-key entry
/dsh-provider-extra-login status         # how each provider authenticates today
```

The command runs inside the server, so the credential lands in the store the routes read, and it serves the next request with no restart. A provider the profile never declared is declared in the `llm-pi-ai` settings as a bare catalog route, because a stored credential no route reads fails the first turn with `no adapter registered`; the write names one provider, so routes and overrides already configured are untouched, and the success message says when it happened. Subscription flows show the page or device code as a dialog question and then finish on their own; a provider that asks for an API key collects it in the same dialog and spends it on one minimal request before anything is written, so a key the provider refuses is reported and never stored, and the value stays out of the model's context either way. The API-key question's id ends in `:secret`, which is how a surface that understands the marker knows to keep the pasted value out of sight; a surface that does not is left with the wording. The command reports success only after reading the stored record back, so a flow that resolves without persisting is reported instead of passed off as a sign-in. Runs only in profiles that compose both the command registry and a session UI; set `loginCommandEnabled: false` to omit it.

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

`check` runs type checking, 30 source tests, the build, three integration tests, the 22 release guard tests, and the package smoke. The plain-Node smoke test mounts both compiled routes in the real Cordis/LLM runtime. Two CLI tests exercise add, repeated add, profile overrides, and remove in disposable web/TUI profiles; they drive the registry CLI this repository develops against (`@deepseek-ai/dsh@0.1.5-rc.2`), so no harness checkout is needed.

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
