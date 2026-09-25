# Managed catalog configuration

Provider-extra remains optional. TUI needs only the host's LLM and default-model contracts.
Without `catalog`, provider-extra keeps its existing additive routes, settings overlays, and login command.
With `catalog`, the profile Config becomes the only owner of model membership and the default.

## Activate one profile

1. Back up the profile patch and legacy settings before migration.
2. Copy the generated `catalog` object into the existing `dsh-provider-extra` row's `config`.
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

Managed mode does not install the legacy settings section or the route-declaring login command.
Where supported, it disables automatic settings projection for its own Config.
Use the existing attended login CLI to store grants; credentials remain separate from configuration.

## Version 1 shape

[Exact 16-pair example](catalog-v1.example.json) contains the complete provider-extra Config, not a new settings file.
Copy its contents into the profile row. The plugin does not read the example file at runtime.

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

## Migration inputs and example provenance

Migration is explicit, not automatic. This package never edits live homes during installation.
Inputs are the composed profile Config, explicit provider-extra extra-model templates and selections,
legacy `llm-pi-ai` route declarations, existing credential references, and the current default selection.
Read legacy settings only to identify previously effective values; resolve conflicting owners before generating the new Config.
Preserve unrelated profile rows, comments, credentials, and user preferences.
Keep backups until restart, rollback, exact membership, and default persistence checks pass.

The example records the approved operator-specific selection of 16 pairs in five routes.
It preserves explicit legacy templates for GPT-6 Sol/Luna, MiMo V2.6 Flash/Pro, and Space Bunny Free.
`space-bunny-free <- mimo-v2.5` was an explicit migration input, not a general recommendation or automatic fallback.
Go's `deepseek-flash <- deepseek-v4-flash` preserves the existing shipped extra-model declaration.
Its selector alias is `deepseek-v4.1-flash`; its wire ID remains `deepseek-flash`.

Qwen DeepSeek preserves the declared context, output limit, modalities, effort map, and compatibility flags.
Its explicit `defaultMaxTokens: 384000` also preserves the legacy request policy.
Grok declares no request default; its inherited output capacity does not create one.
Grok preserves the declared protocol, context, modalities, and effort map.
Its `maxTokens: 32768` materializes the legacy adapter default, not a verified endpoint maximum.
The custom models' zero cost fields materialize legacy `NO_COST`; they mean unknown pricing, not free inference.
These defaults come from released `dsh-llm-pi-ai`'s `resolveRouteModels` and `DEFAULT_MAX_TOKENS`; no private function is called.
Credential references in the example must match the target profile's existing authentication setup.

The example defines configuration, not a guarantee of endpoint support.
Private-clone smoke tests completed requests for these routes:

- `opencode-go-session/deepseek-flash`, with `max`.
- `openai-codex/gpt-6-astra`, with `max` over SSE.
- `qwen-token-plan/qwen3.8-max`.
- `qwen-token-plan/deepseek-v4.1-flash`, with `max` and a wire output cap of 384000 tokens.

OpenAI and XAI requests stopped before HTTP because `OPENAI_API_KEY` and `XAI_API_KEY` were unresolved in the clones.
These results do not establish availability for every selected model or account.
They do not establish authoritative names, pricing, maximum capacities, or template capability equivalence.
Source `0.1.7-alpha.2` tests passed for canonical saves, restart persistence, and field-scoped default rollback preserving newer privacy opt-outs.
Released `0.1.5-rc.3` tests returned the explicit `CONFIG_PERSISTENCE_UNAVAILABLE` refusal.
Repeat smoke tests with authorized credentials before activating another profile.
