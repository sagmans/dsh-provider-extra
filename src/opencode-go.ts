/**
 * OpenCode Go route with per-session routing identity.
 *
 * The OpenCode Go gateway rejects requests that carry no session identity
 * (HTTP 400 MissingSessionID) and uses a stable per-conversation id to optimize
 * routing and prompt caching. The shipped dsh pi-ai adapter forwards the
 * session id into pi-ai's options, but pi-ai emits session headers only for
 * providers whose compat opts in, so this route injects the header itself at
 * the provider delegate — the one boundary every dispatch path (direct
 * stream() and the runtime's prepareCall()) reaches with the per-request
 * options still in hand.
 *
 * @module dsh-provider-extra/opencode-go
 */

import { defaultProviderAuthContext } from '@earendil-works/pi-ai'
import type { Api, AuthContext, Credential, CredentialInfo, CredentialStore, Model, Provider, ProviderHeaders } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveExtraModels } from './extra-models.ts'
import type { ExtraModelSpec } from './extra-models.ts'

/** pi-ai catalog id of the OpenCode Go provider this route mirrors. */
export const OPENCODE_GO_PROVIDER_ID = 'opencode-go'

/** Routing header the OpenCode Go gateway requires on every model request. */
export const SESSION_HEADER_NAME = 'x-opencode-session'

/** Environment variable read for the API key when no credential service is present. */
export const DEFAULT_OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY'

/** Wire id OpenCode Go serves DeepSeek V4.1 Flash under. */
export const DEEPSEEK_V41_FLASH_ID = 'deepseek-flash'

/** Display name for DeepSeek V4.1 Flash, matching the OpenCode Go model list. */
export const DEEPSEEK_V41_FLASH_NAME = 'DeepSeek V4.1 Flash'

/** Default template sibling an extra model inherits its wire behavior from. */
export const DEFAULT_EXTRA_MODEL_TEMPLATE = 'deepseek-v4-flash'

/** Shipped extras for ids the installed catalog predates while the gateway already serves them. */
const DEFAULT_EXTRA_MODELS: readonly ExtraModelSpec[] = [
  { id: DEEPSEEK_V41_FLASH_ID, name: DEEPSEEK_V41_FLASH_NAME, template: DEFAULT_EXTRA_MODEL_TEMPLATE },
]

// The resolved profile defaults below mirror dsh-llm-pi-ai's config resolution,
// which does not export them; drift is caught by that package's own tests.
/** Default maximum idle interval while an adapter stream read is outstanding. */
const STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default request-level bound on base64-encoded image payload per request. */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Default total-pixel budget preserving one 2048px normalized attachment. */
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** Default raw encoded-byte target before inline base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/** Configuration for the single OpenCode Go route this plugin owns. */
export interface OpenCodeGoRouteConfig {
  /** Provider route key; must stay out of llm-pi-ai's providers section. */
  provider: string
  /** Name configuration surfaces show for this route. */
  displayName: string
  /** Credential reference resolved per request; an env-var name. */
  apiKeyEnv: string
  /** Endpoint override applied to every catalog model on this route. */
  baseURL?: string
  /** Routing id used when a request carries no session id (auxiliary calls). */
  fallbackSessionId?: string
  /** Additional static headers merged under the session header. */
  headers?: Record<string, string>
  /** Extra models served beside the installed catalog; read from settings per request. */
  extraModels?: ExtraModelSpec[]
}

/**
 * The per-request stream options this route reads. Structural, so it fits
 * every stream-options type pi-ai's delegates receive without naming them.
 */
interface RoutingStreamOptions {
  sessionId?: string
  headers?: ProviderHeaders
}

/**
 * The installed pi-ai catalog's OpenCode Go provider, whose API implementations
 * and auth this route reuses rather than reconstructing.
 * @throws Error when the installed pi-ai catalog no longer ships OpenCode Go.
 */
function catalogOpenCodeGo(): Provider {
  const found = builtinProviders().find(provider => provider.id === OPENCODE_GO_PROVIDER_ID)
  if (found === undefined) {
    throw new Error(
      'dsh-provider-extra: the installed pi-ai catalog has no provider "' + OPENCODE_GO_PROVIDER_ID + '";'
      + ' pin @earendil-works/pi-ai to a catalog that ships it',
    )
  }
  return found
}

/**
 * Stamp the routing header onto one request's stream options. The request's
 * session id wins, the configured fallback answers sessionless requests, and
 * no id at all sends nothing — an absent header surfaces the gateway's own
 * refusal rather than hiding it behind a fabricated identity. The session
 * header also wins a collision with a configured static header of the same
 * name, because the live identity is the fact the gateway routes on.
 * @param options - the per-request stream options pi-ai is about to dispatch.
 * @param config - the route configuration.
 * @returns the options with the routing header merged in.
 */
function withRoutingHeader<T extends RoutingStreamOptions>(options: T | undefined, config: OpenCodeGoRouteConfig): T | undefined {
  if (options === undefined) return undefined
  const routingId = options.sessionId ?? config.fallbackSessionId
  if (routingId === undefined) return options
  // The spread keeps every member of the exact option type pi-ai handed over;
  // only the routing header is set, so the cast only widens back to that type.
  return { ...options, headers: { ...options.headers, [SESSION_HEADER_NAME]: routingId } } as T
}

/**
 * The catalog provider re-keyed for this route, mirroring dsh-llm-pi-ai's
 * catalog-provider reuse: dispatch stays with the catalog provider so its API
 * implementations and quirks survive, while identity and models answer to the
 * route configuration. The delegates are also where the routing header enters:
 * every dispatch path funnels through them with the request's own options.
 * @param config - the route configuration.
 * @param catalog - the installed catalog provider to reuse.
 * @param extras - resolved extra models, re-keyed here like catalog models.
 * @returns the provider to register into the adapter's model collection.
 */
function routeProvider(config: OpenCodeGoRouteConfig, catalog: Provider, extras: readonly Model<Api>[]): Provider {
  const models = [...catalog.getModels(), ...extras].map(model => ({
    ...model,
    ...config.baseURL === undefined ? {} : { baseUrl: config.baseURL },
    provider: config.provider,
  }))
  return {
    id: config.provider,
    name: config.displayName,
    ...config.baseURL === undefined ? {} : { baseUrl: config.baseURL },
    auth: catalog.auth,
    getModels: () => models,
    stream: (model, context, options) => catalog.stream(model, context, withRoutingHeader(options, config)),
    streamSimple: (model, context, options) => catalog.streamSimple(model, context, withRoutingHeader(options, config)),
  }
}

/**
 * The resolved profile for the route: static facts only, because everything
 * per-request lives in the provider delegates where the request's options flow.
 * @param config - the route configuration.
 * @returns the resolved profile the adapter freezes into its snapshot.
 */
export function buildOpenCodeGoProfile(config: OpenCodeGoRouteConfig): ResolvedPiAiProviderProfile {
  const catalog = catalogOpenCodeGo()
  const extras = resolveExtraModels(
    catalog.getModels(),
    [...DEFAULT_EXTRA_MODELS, ...(config.extraModels ?? [])],
    DEFAULT_EXTRA_MODEL_TEMPLATE,
  )
  return {
    provider: config.provider,
    displayName: config.displayName,
    ...config.headers === undefined ? {} : { headers: { ...config.headers } },
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-provider-extra: opencode-go'),
    modelErrors: extras.modelErrors,
    configuredMaxTokens: new Map(),
    piProvider: routeProvider(config, catalog, extras.models),
  }
}

/**
 * Auth for a route whose only method is the harness-resolved API key: the
 * in-memory store stays empty because nothing logs in, and the ambient context
 * answers the provider's environment questions from process.env.
 */
export function openCodeGoAuth(): { credentials: CredentialStore; authContext: AuthContext } {
  return { credentials: new EmptyCredentialStore(), authContext: defaultProviderAuthContext() }
}

/** Credential store that holds nothing: the harness resolves this route's key itself. */
class EmptyCredentialStore implements CredentialStore {
  read(): Promise<Credential | undefined> {
    return Promise.resolve(undefined)
  }

  list(): Promise<readonly CredentialInfo[]> {
    return Promise.resolve([])
  }

  modify(_providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return fn(undefined)
  }

  delete(): Promise<void> {
    return Promise.resolve()
  }
}
