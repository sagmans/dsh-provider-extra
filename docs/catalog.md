# Managed catalog configuration

Provider-extra remains optional. TUI needs only the host's LLM and default-model contracts.
Without `catalog`, provider-extra keeps its existing additive routes, settings overlays, and login command.
With `catalog`, the profile Config becomes the only owner of model membership and the default.

## Activate one profile

1. Back up the profile patch and legacy settings before migration.
2. Copy your validated `catalog` object into the existing `dsh-provider-extra` row's `config`.
3. Disable competing provider rows and `agent-default-model` in that profile only.
4. Restart the profile after a successful build.

Do not modify global bundles or ordinary profiles. Do not remove the core `llm` service.
Disable native adapters and the generic `llm-pi-ai` row, including dormant generic provider directories.
For example, a profile with these row IDs needs these overrides:

```yaml
- id: llm-deepseek
  disabled: true
- id: llm-openai
  disabled: true
- id: llm-anthropic
  disabled: true
- id: llm-pi-ai
  disabled: true
- id: agent-default-model
  disabled: true
```

Inspect the composed profile for additional provider rows or different IDs.
Mount provider-extra after those rows so its preflight can detect existing owners.
Preflight rejects any existing adapter, provider directory, or default owner before registering managed routes.
It never disables another plugin. The public registry cannot veto a later unrelated adapter or directory registration.
The public `llm/adapters-updated` notification detects that conflict immediately and logs `CATALOG_OWNER_COLLISION`.
Managed listing, resolution, preparation, defaults, saves, and new dispatch fail closed while the conflict exists.
A captured request checks ownership before and after API-key or OAuth grant lookup.
OAuth modification checks again before entering the store and its locked updater, then after completion.
A successful refresh already started under valid ownership persists its rotated grant, even if a conflict appears before completion.
The completion guard then rejects model dispatch; it never rolls back authentication or discards the rotated token.
Public pi-ai can normalize OAuth store failures to `PI_AI_ERROR`; their message retains the unmistakable `CATALOG_OWNER_COLLISION` detail.
Requests already past all credential gates continue with their captured generation; topology changes do not cancel in-flight work.
The plugin keeps its valid snapshot and registrations intact, then recovers when competing rows disappear.
It logs once per transition into conflict, not once per failed operation.
Unrelated global rows remain observable through the public registry; the plugin never filters or rewrites that directory.
Therefore activation must remove competing rows from the entire profile, not only the earlier rows.

Managed mode does not install the legacy settings section or declare generic routes during sign-in.
Where supported, it disables automatic settings projection for its own Config.
The existing sign-in command uses the selected catalog routes and their configured credential references.
Credentials remain separate from configuration. The attended CLI supports Codex only.

## Version 1 shape

[Shape example](catalog-v1.example.json) validates with synthetic `example-` identifiers and illustrative metadata.
Its model does not identify a real endpoint model. Replace the model, metadata, and credential reference before dispatch.
The supported `openai` source illustrates the schema; it is not a recommended provider selection.
The plugin reads the profile Config, not this example or another catalog file.

- `catalog.version`: required integer `1`.
- `catalog.providers`: required ordered array of selected routes.
- `catalog.default`: one `{ provider, model, reasoningEffort? }` selection, or `null` when no models are selected.
- Provider `id`: unique route ID used by the host.
- Provider `name`: explicit display name.
- Provider `source`: supported installed pi-ai backend: `openai`, `openai-codex`, `opencode-go`, `qwen-token-plan`, or `xai`.
- Provider `auth`: exactly one of `{ apiKeyRef }` or `{ credentialProvider }`.
- `apiKeyRef`: host credential reference, not a secret value. Without a credential service, the route reads that environment variable.
- `credentialProvider`: the source provider ID. Route aliases share that source's existing `llm-pi-ai` credential record.
- Provider `models`: required ordered array. Each model requires a wire `id` and explicit `name`.
- Model `aliases`: optional unique selector inputs. Aliases never create additional listing rows.
- Model `template`: optional explicit installed model ID from the same source.
- Model `metadata`: optional public pi-ai model facts. Overrides apply even when pi-ai already ships the requested ID.
- Model `defaultMaxTokens`: optional explicit request default, used only when the request supplies no output cap.
  It must be a positive safe integer no greater than the resolved model capacity.
- Provider `baseURL`: optional HTTP(S) endpoint override, without embedded credentials or fragments.
- Provider `headers`: optional static HTTP headers. Keep secrets in credential references.
- Provider `transport`: optional Codex transport: `sse`, `websocket`, `websocket-cached`, or `auto`.
- Provider `fallbackSessionId`: optional OpenCode Go identity for requests without a session ID.

Unknown fields, duplicate IDs or aliases, unknown sources, malformed metadata, and unsupported default effort reject the whole candidate.
Omitting `catalog` differs from `providers: []`. Empty provider or model arrays select nothing; they never expand a source catalog.
An empty provider list requires `default: null`. A nonempty model selection requires one valid default.
A selected route with `models: []` remains empty even when pi-ai ships models for its source.

### Model metadata

Known models inherit facts from their installed source unless explicitly overridden.
An explicit template retains the requested wire ID and name; it does not rename a sibling silently.
Templates express operator intent, not endpoint support or verified capability equivalence.

An unknown model without a template requires all these metadata fields:

- `api`: a protocol implemented by the source.
- `reasoning`: boolean.
- `input`: nonempty list of `text` and/or `image`.
- `cost`: finite nonnegative `input`, `output`, `cacheRead`, and `cacheWrite` rates.
- `contextWindow` and `maxTokens`: positive safe integers.

Optional `thinkingLevelMap` maps supported levels to wire values; `null` disables a level.
Levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
Protocol-compatible `compat` overrides and model `headers` are validated before mounting.
The public exported TypeScript contracts define the accepted metadata subset.
`metadata.maxTokens` describes model capacity; it does not impose a request output cap.
Migrate an explicit legacy generic `models[].maxTokens` request default into `defaultMaxTokens` as well.
Never infer `defaultMaxTokens` from an inherited capability. An explicit per-request cap still takes precedence.

## Shared snapshot and persistence

Public `compileCatalog(config)` returns a detached, immutable snapshot, or `undefined` for absence.
Public `buildCatalogProfile(provider)` constructs a validated route through installed pi-ai delegates.
No private generic resolver is used.
The snapshot supplies listings, exact model resolution, prepared dispatch, and `agentDefaultModel.currentSelection()`.
On the pinned host matrix, the catalog default contributes only provider and model to new sessions.
That host ignores `catalog.default.reasoningEffort`; choose reasoning effort in the session surface.
`resolveSelection()` canonicalizes aliases for defaults and saves; host calls use listed wire IDs.
An empty catalog's `currentSelection()` rejects with `NO_DEFAULT_MODEL`.

Go delegates preserve `x-opencode-session` from the live session, with the configured fallback for sessionless calls.
Codex keeps OAuth grant refresh and the explicitly pinned transport. It never uses an API-key override.

`saveSelection(next)` validates the selection before any write.
Where `configEditor.edit(owner.fiber.entry, updater)` exists, it changes only `catalog.default` in the same Config.
The updater preserves other fields and revalidates membership against the editor's current locked configuration.
The promise awaits the editor's validation, persistence, and reconciliation.
Failures propagate without publishing a local-only default.
Hosts without an addressable entry and that editor reject with `CONFIG_PERSISTENCE_UNAVAILABLE`.
The released `0.1.5-rc.2` host has no verified canonical editor; edit its profile patch explicitly.
No fallback writes legacy `agent-default-model` settings or another file.

The catalog is nonvolatile. Successful edits follow the host's normal plugin restart lifecycle.
Schema validation runs before Loader disposal, preserving valid state on an invalid reload.
A pre-disposal update check also retains that state if a competing adapter appeared after activation.
Prepared calls retain their captured adapter revision across successful reloads.
External lifecycle failures and startup ordering still depend on the host; parent runtime tests cover profile reconciliation.

## Migration inputs

Migration is explicit. Installation never activates a catalog or edits a live home.
Use the composed profile, declared templates, credential references, and current default as migration inputs.
Read legacy settings only to identify previously effective values. Resolve conflicting owners before activation.
Preserve unrelated rows, comments, credentials, and preferences.
Keep backups until restart, rollback, membership, and default persistence checks pass.

A model template expresses operator intent, not verified endpoint compatibility.
Zero cost metadata means unknown pricing, not free inference.
Test selected models separately with authorized credentials before adopting another profile.
Keep personal model selections outside the package and repository fixtures.

## Clone-only development setup

This source-checkout command prepares a new private clone without launching a profile.
It never authenticates, contacts a model, or writes the source home.
The clone can contain copied credentials. Keep it private and never commit it.

1. Install this checkout's dependencies and supply an existing profile to clone.
2. Prepare a private JSON file containing only your complete `{"catalog": {...}}` Config.
3. Supply the existing generic dogfood helper as an explicit development-tool path.
4. Choose a nonexistent clone path whose parent already exists.
5. Run:

```sh
pnpm catalog:setup \
  --helper /path/to/run-plugin-from-worktree.sh \
  --source-home /path/to/source-home \
  --home /path/to/new-private-clone \
  --profile web \
  --catalog /private/path/catalog-config.json \
  [--allow-row ROW_ID]...
```

`--catalog` is required. There is no packaged selection or implicit model set.
Setup refuses a row whose name reads like a model provider unless `--allow-row ROW_ID` asserts that
row registers no provider and no default owner. A real home carries such rows, and setup cannot see
row provenance, so the flag keeps the check fail-closed instead of guessing; failure output names the
row and prints the flag to use. Boot-time `CATALOG_OWNER_COLLISION` stays authoritative either way.
The shape example validates, but its synthetic model cannot serve requests; replace it with your own selection.
The helper is optional development tooling, not a provider runtime dependency.
A checkout of the independent TUI currently carries it under:

```text
.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh
```

Use the generic helper, not the TUI-specific wrapper.
The command builds this provider checkout and relinks only this package in the fresh clone.
It uses the locally installed development harness by default.
To select another installed harness, add `--dsh /absolute/path/to/dsh/lib/bin.js`.
Pass the actual JavaScript bin, not a shell launcher. Setup prints the matching launch command.

Setup appends JSON flow-map sequence rows to the clone's profile patch.
It retains all original patch bytes and uses the selected host's public parser and composition API.
It disables recognized native adapters, the generic pi-ai adapter, and the default owner by their actual composed IDs.
It preserves the core LLM service and unrelated configuration.
The command checks the resolved provider module and isolated catalog listing/default APIs before replacing the clone patch.

Success means `composition-verified`, not verified runtime ownership or authentication.
Setup does not boot arbitrary profile plugins or infer their service ownership.
Boot-time `CATALOG_OWNER_COLLISION` remains authoritative, including for late-mounted plugins.
Launch only the printed clone command, then use sign-in status to inspect authentication.
The released host can still reject persistent default saves with `CONFIG_PERSISTENCE_UNAVAILABLE`.
No setup path writes legacy defaults as a fallback.

Setup refuses existing or overlapping homes, unsafe clone files, and unresolved or mismatched provider builds.
It also refuses unknown provider-like rows, opaque nested/include rows, and missing or duplicate core/catalog owners.
Profile patches must accept appended block-sequence rows; flow arrays and closed YAML documents require manual clone-only setup.
Home-level overrides must not counteract the catalog or disabled owner rows.
A refusal leaves the source home unchanged and never reports success.
A failed setup can leave a private clone for inspection; choose another new path for the next attempt.
