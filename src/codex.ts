/**
 * OpenAI Codex (ChatGPT subscription) route over pi-ai's OAuth.
 *
 * DSH core already translates pi-ai's Codex login into the neutral
 * authorization vocabulary, but no shipped surface consumes that seam: no CLI
 * command, no web UI, no RPC reaches it. So this plugin owns both halves the
 * seam would have connected — the route serving subscription requests, and
 * the login script (src/codex-login.ts) writing the grant — while reusing
 * pi-ai's OAuth implementation itself, never reimplementing it.
 *
 * @module dsh-provider-extra/codex
 */

import { defaultProviderAuthContext } from '@earendil-works/pi-ai'
import type { Api, AuthContext, Credential, CredentialInfo, CredentialStore, Model, Provider, Transport } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import {
  credentialKey,
  credentialKeyId,
  credentialKeyScope,
  isCredentialKeySegment,
} from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveExtraModels, selectWhitelistedModels } from './extra-models.ts'
import type { ExtraModelSpec } from './extra-models.ts'

/** pi-ai catalog id of the ChatGPT-subscription provider this route serves. */
export const CODEX_CATALOG_ID = 'openai-codex'

/**
 * Default route id. It deliberately equals the catalog id: the credential
 * record address derives from it, so sharing the id shares the grant with
 * DSH core's own Codex flow instead of forking a second sign-in.
 */
export const DEFAULT_CODEX_ROUTE_ID = CODEX_CATALOG_ID

/** Display name for selectors, matching pi-ai's subscription label. */
export const DEFAULT_CODEX_DISPLAY_NAME = 'OpenAI Codex'

/**
 * Transports pi-ai's Codex API accepts, as that API declares them. Named here
 * because a profile pins one: the websocket path keeps a connection-scoped
 * continuation cache, which some networks and proxies never let complete.
 */
export const CODEX_TRANSPORTS = ['sse', 'websocket', 'websocket-cached', 'auto'] as const

/**
 * Record scope for the OAuth grant. Identical to dsh-llm-pi-ai's own scope,
 * which is what makes a grant written by the login script readable by core's
 * flow (and vice versa) instead of stranding two sign-ins in two namespaces.
 */
const RECORD_SCOPE = 'llm-pi-ai'

/** The record address for one pi-ai provider id. */
export function recordKeyFor(providerId: string): CredentialKey {
  return credentialKey(RECORD_SCOPE, providerId)
}

/** The credential seam when present; resolved per call, never at mount. */
export interface CodexCredentialService {
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
  listRecords(): Promise<readonly { key: CredentialKey; kind: CredentialRecord['kind'] }[]>
  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>
  deleteRecord(key: CredentialKey): Promise<void>
}

/**
 * The JSON image of one grant payload: plain objects lose their
 * explicitly-undefined members, exactly as JSON.stringify would render them.
 * pi-ai credentials idiomatically carry optional members as explicit
 * undefined, which the credential store's strict validator refuses as
 * unrepresentable.
 */
function jsonImage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => entry === undefined ? null : jsonImage(entry))
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const image: Record<string, unknown> = {}
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) image[key] = jsonImage(member)
    }
    return image
  }
  return value
}

/** Translate a stored record into the credential pi-ai expects. */
function toPiCredential(record: CredentialRecord | undefined): Credential | undefined {
  if (record === undefined) return undefined
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...record.key === undefined ? {} : { key: record.key },
      ...record.env === undefined ? {} : { env: { ...record.env } },
    }
  }
  return record.payload as Credential
}

/** Translate a pi-ai credential into the record to store. */
function toRecord(credential: Credential): CredentialRecord {
  if (credential.type === 'api_key') {
    return {
      kind: 'api-key',
      ...credential.key === undefined ? {} : { key: credential.key },
      ...credential.env === undefined ? {} : { env: { ...credential.env } },
    }
  }
  return { kind: 'grant', payload: jsonImage(credential) }
}

/**
 * A pi-ai CredentialStore over the harness credential records, addressed at
 * the shared record scope so core and extra read each other's grants.
 */
export class HarnessCredentialStore implements CredentialStore {
  constructor(private readonly credentials: () => CodexCredentialService | undefined) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const credentials = this.credentials()
    if (credentials === undefined) return undefined
    if (!isCredentialKeySegment(providerId)) return undefined
    return toPiCredential(await credentials.readRecord(recordKeyFor(providerId)))
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const stored = await this.credentials()?.listRecords() ?? []
    const mine: CredentialInfo[] = []
    for (const entry of stored) {
      // Records another plugin owns are not this collection's to report:
      // their payloads are written in a format pi-ai never agreed to.
      if (credentialKeyScope(entry.key) !== RECORD_SCOPE) continue
      mine.push({
        providerId: credentialKeyId(entry.key),
        type: entry.kind === 'api-key' ? 'api_key' : 'oauth',
      })
    }
    return mine
  }

  async modify(
    providerId: string,
    mutate: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (!isCredentialKeySegment(providerId)) {
      throw new LlmError(
        'dsh-provider-extra: provider id "' + providerId + '" cannot address a stored credential record (a record id is a'
        + ' lowercase hyphenated identifier)',
        'UNSTORABLE_PROVIDER_ID',
      )
    }
    const credentials = this.credentials()
    if (credentials === undefined) {
      throw new LlmError(
        'dsh-provider-extra: this composition mounts no credentials service, so there is nowhere to store the'
        + ' credential a sign-in produces; mount one (dsh-credentials-local) to sign in',
        'NO_CREDENTIAL_STORE',
      )
    }
    const stored = await credentials.modifyRecord(recordKeyFor(providerId), async (current) => {
      const next = await mutate(toPiCredential(current))
      return next === undefined ? undefined : toRecord(next)
    })
    return toPiCredential(stored)
  }

  async delete(providerId: string): Promise<void> {
    if (!isCredentialKeySegment(providerId)) return
    await this.credentials()?.deleteRecord(recordKeyFor(providerId))
  }
}

/** Configuration for the Codex subscription route this plugin owns. */
export interface CodexRouteConfig {
  /**
   * Provider route key. Defaults to the catalog id so the grant address is
   * shared with core; keep it out of llm-pi-ai's providers section, which
   * would refuse this route as a duplicate adapter.
   */
  provider: string
  /** Name configuration surfaces show for this route. */
  displayName: string
  /** Extra models served beside the installed catalog; read from settings per request. */
  extraModels?: ExtraModelSpec[]
  /** Exact model ids to serve, in this order; absent serves the whole catalog plus extras. */
  models?: readonly string[]
  /** Transport to pin on every request; absent leaves pi-ai's own choice alone. */
  transport?: Transport
}

/**
 * The per-request stream options this route reads. Structural, so it fits every
 * stream-options type pi-ai's delegates receive without naming them.
 */
interface TransportStreamOptions {
  transport?: Transport
}

/**
 * Stamp the pinned transport onto one request's stream options. pi-ai selects
 * its Codex transport per request, so this is the only boundary where a profile
 * can choose one; a route that pins none hands pi-ai's options through exactly
 * as it received them.
 * @param options - the per-request stream options pi-ai is about to dispatch.
 * @param config - the route configuration.
 * @returns the options with the transport pinned, or unchanged when none is.
 */
export function withTransport<T extends TransportStreamOptions>(options: T | undefined, config: CodexRouteConfig): T | undefined {
  if (config.transport === undefined || options === undefined) return options
  return { ...options, transport: config.transport }
}

/**
 * The installed pi-ai catalog's Codex provider, whose API implementation,
 * OAuth auth, and model list this route reuses rather than reconstructing.
 * Exported for the login script, which signs into this same object so the
 * grant it writes is the one the route reads.
 * @throws Error when the installed pi-ai catalog no longer ships Codex.
 */
export function catalogCodex(): Provider {
  const found = builtinProviders().find(provider => provider.id === CODEX_CATALOG_ID)
  if (found === undefined) {
    throw new Error(
      'dsh-provider-extra: the installed pi-ai catalog has no provider "' + CODEX_CATALOG_ID + '";'
      + ' pin @earendil-works/pi-ai to a catalog that ships it',
    )
  }
  return found
}

/**
 * The catalog provider re-keyed for this route. Dispatch stays with the
 * catalog provider so its API implementation and OAuth quirks survive, while
 * identity and models answer to the route configuration.
 */
function routeProvider(config: CodexRouteConfig, catalog: Provider, models: readonly Model<Api>[]): Provider {
  const routed: Model<Api>[] = models.map(model => ({
    ...model,
    provider: config.provider,
  }))
  // The request-level apiKey override stays absent (see codexApiKey): auth
  // resolves from the collection store holding the OAuth grant, which is
  // also what lets pi-ai refresh an expired token under its own lock.
  return {
    id: config.provider,
    name: config.displayName,
    auth: catalog.auth,
    getModels: () => routed,
    stream: (model, context, options) => catalog.stream(model, context, withTransport(options, config)),
    streamSimple: (model, context, options) => catalog.streamSimple(model, context, withTransport(options, config)),
  }
}

// The resolved profile defaults below mirror dsh-llm-pi-ai's config
// resolution, which does not export them; drift is caught by that package's
// own tests, as with the OpenCode Go route.
/** Default maximum idle interval while an adapter stream read is outstanding. */
const STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default request-level bound on base64-encoded image payload per request. */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Default total-pixel budget preserving one 2048px normalized attachment. */
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** Default raw encoded-byte target before inline base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/**
 * The resolved profile for the route. It names no credential reference: the
 * subscription authenticates from the stored OAuth grant, never from an
 * environment key, so there is nothing to fail loud about at request time —
 * pi-ai's own honest refusal names the missing sign-in instead.
 */
export function buildCodexProfile(config: CodexRouteConfig): ResolvedPiAiProviderProfile {
  const catalog = catalogCodex()
  // Codex ships no fallback template: a sibling from another vendor's gateway
  // would be dispatched as if the subscription served it, so a declaration
  // that names none is reported instead of cloned.
  const extras = resolveExtraModels(catalog.getModels(), config.extraModels ?? [])
  // Selection runs last so a whitelist may name a declared extra exactly as it
  // names a catalog model, and so a typo in either is refused here rather than
  // served as a route quietly missing a model.
  const models = selectWhitelistedModels(config.provider, [...catalog.getModels(), ...extras.models], config.models)
  return {
    provider: config.provider,
    displayName: config.displayName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-provider-extra: openai-codex'),
    modelErrors: extras.modelErrors,
    configuredMaxTokens: new Map(),
    piProvider: routeProvider(config, catalog, models),
  }
}

/**
 * The per-request credential for the Codex route: always absent, deferring
 * to the collection's OAuth store. A named reference would let a stray
 * environment key (OPENAI_API_KEY and friends) bill another tenant for a
 * request the deployment meant to authenticate as the subscription.
 */
export function codexApiKey(): Promise<string | undefined> {
  return Promise.resolve(undefined)
}

// The ambient context answers from the process environment (pi-ai's own
// default) rather than the harness seam: Codex resolves no ambient
// credential env at request time — its only env knob,
// PI_OAUTH_CALLBACK_HOST, is login-time and process-owned — so seam lookup
// would add a dependency for a question that is never asked.
/**
 * Auth for the Codex route: the harness-backed grant store plus pi-ai's own
 * ambient context. The OpenCode Go route shares this injection unharmed: its
 * key arrives as the request-level override, which pi-ai prefers over every
 * store read, so a store holding only the Codex grant changes nothing for it.
 */
export function codexAuth(credentials: () => CodexCredentialService | undefined): {
  credentials: CredentialStore
  authContext: AuthContext
} {
  return { credentials: new HarnessCredentialStore(credentials), authContext: defaultProviderAuthContext() }
}
