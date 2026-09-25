/** A route borrows an installed backend's protocol or declares its own; either way it owns its model facts. */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { createProvider } from '@earendil-works/pi-ai'
import type { Api, ApiKeyAuth, Model, Provider, StreamOptions } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { CatalogFilter, CatalogProvider } from './catalog.ts'
import { PROTOCOL_STREAMS } from './catalog-protocols.ts'

const ERROR_PREFIX = 'dsh-provider-extra: catalog '
const ROUTE_FIELDS = ['id', 'name', 'source', 'api', 'auth', 'models', 'filter', 'baseURL', 'headers', 'transport', 'fallbackSessionId']
const MODEL_FIELDS = ['id', 'name', 'aliases', 'template', 'metadata', 'defaultMaxTokens']
const METADATA_FIELDS = ['api', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'headers', 'compat']
const REQUIRED_METADATA = ['api', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens']
const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite']
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const TRANSPORTS = ['sse', 'websocket', 'websocket-cached', 'auto']
const GO_SOURCE = 'opencode-go'
const CODEX_SOURCE = 'openai-codex'
const SESSION_HEADER = 'x-opencode-session'
const STREAM_IDLE_TIMEOUT_MS = 300_000
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
const HTTP_PROTOCOLS = ['http:', 'https:']
const COMPLETIONS_API = 'openai-completions'
const RESPONSES_APIS = ['openai-responses', 'azure-openai-responses', 'openai-codex-responses']
const ANTHROPIC_API = 'anthropic-messages'
const COMPLETIONS_FLAGS = ['supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming', 'supportsFinishReason', 'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages', 'zaiToolStream', 'supportsThinkingTokenBudget', 'supportsOpenAIGrammarTools', 'supportsStrictMode', 'sendSessionAffinityHeaders', 'supportsLongCacheRetention']
const RESPONSES_FLAGS = ['supportsDeveloperRole', 'supportsLongCacheRetention', 'supportsStrictMode', 'supportsOpenAIGrammarTools', 'supportsAdditionalTools', 'supportsToolSearch', 'supportsExplicitPromptCacheMode', 'supportsMaxOutputTokens']
const ANTHROPIC_FLAGS = ['supportsEagerToolInputStreaming', 'supportsLongCacheRetention', 'sendSessionAffinityHeaders', 'supportsCacheControlOnTools', 'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools', 'supportsMidConvoEffort', 'supportsToolReferences']
const COMPAT_ENUMS: Record<string, readonly string[]> = {
  maxTokensField: ['max_completion_tokens', 'max_tokens'],
  thinkingFormat: ['openai', 'openrouter', 'deepseek', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling'],
  thinkingTokenBudgetField: ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'],
  cacheControlFormat: ['anthropic'], deferredToolsMode: ['kimi'],
  sessionAffinityFormat: ['openai', 'openai-nosession', 'openrouter'],
}
/** @internal Consistent paths make invalid declarations repairable before publication. */
export function catalogError(path: string, reason: string): never {
  throw new Error(ERROR_PREFIX + path + ': ' + reason)
}

/** @internal Unknown fields must fail rather than look applied. */
export function catalogRecord(value: unknown, fields: readonly string[] | undefined, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) catalogError(path, 'expected an object')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (fields && !fields.includes(key))) catalogError(path, 'unknown field ' + String(key))
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!('value' in descriptor)) catalogError(path, 'accessors are not configuration values')
  }
  return value as Record<string, unknown>
}

/** @internal IDs and labels cannot hide accidental whitespace or control characters. */
export function catalogString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    catalogError(path, 'expected a nonempty string without surrounding whitespace or control characters')
  }
}

/** @internal Deep freezing protects old snapshots from callers retaining nested references. */
export function freezeCatalogValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) freezeCatalogValue(member)
    Object.freeze(value)
  }
  return value
}

/** @internal A frozen Map still permits set(); a facade keeps its mutable storage private. */
export function catalogMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const map = new Map(entries)
  const view: ReadonlyMap<K, V> = Object.freeze({
    size: map.size,
    get: (key: K) => map.get(key), has: (key: K) => map.has(key),
    keys: () => map.keys(), values: () => map.values(), entries: () => map.entries(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => {
      map.forEach((value, key) => callback.call(thisArg, value, key, view))
    },
  })
  return view
}

function number(value: unknown, path: string, positive = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && (!Number.isSafeInteger(value) || value === 0))) {
    catalogError(path, positive ? 'expected a positive safe integer' : 'expected a finite nonnegative number')
  }
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) catalogError(path, 'expected an array')
  for (const item of value) catalogString(item, path)
  if (new Set(value).size !== value.length) catalogError(path, 'duplicate entry')
  return value
}

function headers(value: unknown, path: string): void {
  for (const [key, member] of Object.entries(catalogRecord(value, undefined, path))) {
    if (typeof member !== 'string') catalogError(path, 'header values must be strings')
    try { new Headers({ [key]: member }) } catch { catalogError(path, 'invalid HTTP header') }
  }
}

function cost(value: unknown, path: string, tier = false): void {
  const fields = [...COST_FIELDS, ...(tier ? ['inputTokensAbove'] : ['tiers'])]
  const data = catalogRecord(value, fields, path)
  for (const key of COST_FIELDS) number(data[key], path + '.' + key)
  if (tier) number(data.inputTokensAbove, path + '.inputTokensAbove')
  else if ('tiers' in data) {
    if (!Array.isArray(data.tiers)) catalogError(path, 'tiers must be an array')
    for (const entry of data.tiers) cost(entry, path + '.tiers', true)
  }
}

/** Only metadata the managed protocols can honor belongs in configuration. */
function compat(value: unknown, api: string, path: string): void {
  const flags = api === COMPLETIONS_API ? COMPLETIONS_FLAGS : RESPONSES_APIS.includes(api) ? RESPONSES_FLAGS
    : api === ANTHROPIC_API ? ANTHROPIC_FLAGS : []
  const enums = api === COMPLETIONS_API ? Object.keys(COMPAT_ENUMS) : RESPONSES_APIS.includes(api) ? ['sessionAffinityFormat'] : []
  const data = catalogRecord(value, [...flags, ...enums], path)
  for (const [key, member] of Object.entries(data)) {
    if (flags.includes(key)) {
      if (typeof member !== 'boolean') catalogError(path, key + ' must be boolean')
    } else if (!COMPAT_ENUMS[key]!.includes(member as string)) catalogError(path, 'invalid ' + key)
  }
}

function metadata(value: unknown, api: string | undefined, path: string): void {
  const data = catalogRecord(value, METADATA_FIELDS, path)
  for (const [key, member] of Object.entries(data)) {
    if (key === 'api') catalogString(member, path + '.api')
    else if (key === 'reasoning') {
      if (typeof member !== 'boolean') catalogError(path, 'reasoning must be boolean')
    } else if (key === 'input') {
      const modes = strings(member, path + '.input')
      if (!modes.length || modes.some(mode => !['text', 'image'].includes(mode))) catalogError(path, 'invalid input modalities')
    } else if (key === 'contextWindow' || key === 'maxTokens') number(member, path + '.' + key, true)
    else if (key === 'cost') cost(member, path + '.cost')
    else if (key === 'headers') headers(member, path + '.headers')
    else if (key === 'thinkingLevelMap') {
      for (const level of Object.values(catalogRecord(member, THINKING_LEVELS, path))) {
        if (level !== null) catalogString(level, path)
      }
    } else if (key === 'compat') compat(member, data.api as string ?? api ?? '', path + '.compat')
  }
}

/** Provider auth contains functions, so structuredClone cannot detach its declaration. */
function detachedAuth<T>(value: T): T {
  if (Array.isArray(value)) return value.map(detachedAuth) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, detachedAuth(member)])) as T
  }
  return value
}

/** Case-insensitive merging prevents stale static session headers from competing with live identity. */
function routeOptions<T extends StreamOptions>(options: T | undefined, config: CatalogProvider): T | undefined {
  if (!config.headers && !config.transport && config.source !== GO_SOURCE) return options
  const headers = Object.fromEntries(
    [...Object.entries(config.headers ?? {}), ...Object.entries(options?.headers ?? {})]
      .map(([key, value]) => [key.toLowerCase(), value]),
  )
  const sessionId = options?.sessionId ?? config.fallbackSessionId
  if (config.source === GO_SOURCE && sessionId !== undefined) headers[SESSION_HEADER] = sessionId
  return { ...options, headers, ...(config.transport === undefined ? {} : { transport: config.transport }) } as T
}

/** `*` is the only wildcard; every other character matches itself. */
function patterns(value: unknown, path: string): RegExp[] {
  const list = strings(value, path)
  if (list.length === 0) catalogError(path, 'expected at least one pattern')
  return list.map(pattern => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'))
}

/** Expansion keeps every installed fact, so curating a catalog costs no restatement. */
function filteredModels(filter: unknown, source: Provider, input: CatalogProvider, path: string): Model<Api>[] {
  const data = catalogRecord(filter, ['include', 'exclude'], path)
  const include = 'include' in data ? patterns(data.include, path + '.include') : undefined
  const exclude = 'exclude' in data ? patterns(data.exclude, path + '.exclude') : undefined
  if (include === undefined && exclude === undefined) catalogError(path, 'declare include, exclude, or both')
  return source.getModels()
    .filter(model => (include === undefined || include.some(pattern => pattern.test(model.id)))
      && !(exclude ?? []).some(pattern => pattern.test(model.id)))
    .map(model => {
      const baseUrl = input.baseURL ?? model.baseUrl ?? source.baseUrl
      if (baseUrl === undefined) catalogError(path, 'model "' + model.id + '" publishes no endpoint; declare baseURL')
      return structuredClone({ ...model, provider: input.id, baseUrl })
    })
}

/** pi-ai requires auth semantics on every provider; the harness resolves this route's key before dispatch. */
function harnessApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

/** A standalone builder validates its complete declaration before constructing any adapter profile. */
export function buildCatalogProfile(input: CatalogProvider): ResolvedPiAiProviderProfile {
  const path = 'provider'
  const raw = catalogRecord(input, ROUTE_FIELDS, path)
  catalogString(raw.id, path + '.id')
  catalogString(raw.name, path + '.name')
  // No backend list gates a profile: `source` names an installed pi-ai provider and
  // anything else is the user's own endpoint, whose protocol they declare.
  const source = 'source' in raw ? (catalogString(raw.source, path + '.source'), builtinProviders().find(provider => provider.id === raw.source)) : undefined
  if ('source' in raw && source === undefined) catalogError(path + '.source', 'unknown installed provider ' + raw.source)
  const declaredApi = 'api' in raw ? (catalogString(raw.api, path + '.api'), raw.api as string) : undefined
  if (source === undefined) {
    if (declaredApi === undefined) catalogError(path + '.api', 'a route with no installed source must declare its protocol')
    if (!(declaredApi in PROTOCOL_STREAMS)) catalogError(path + '.api', 'unsupported protocol ' + declaredApi + '; this build implements ' + Object.keys(PROTOCOL_STREAMS).join(', '))
  } else if (declaredApi !== undefined) catalogError(path + '.api', 'api belongs to a route with no installed source')
  const auth = 'auth' in raw ? catalogRecord(raw.auth, ['apiKeyRef', 'credentialProvider'], path + '.auth') : undefined
  if (auth !== undefined) {
    if (Object.keys(auth).length !== 1) catalogError(path + '.auth', 'choose exactly one credential mode')
    if ('apiKeyRef' in auth) {
      if (source?.id === CODEX_SOURCE) catalogError(path + '.auth', 'openai-codex requires credentialProvider OAuth')
      catalogString(auth.apiKeyRef, path + '.auth.apiKeyRef')
      credentialRef(auth.apiKeyRef)
    } else if (source === undefined) catalogError(path + '.auth', 'credentialProvider needs an installed source to own the grant')
    else if (auth.credentialProvider !== source.id) catalogError(path + '.auth', 'credentialProvider must equal source')
  }
  if ('baseURL' in raw) {
    catalogString(raw.baseURL, path + '.baseURL')
    let url: URL
    try { url = new URL(raw.baseURL) } catch { catalogError(path, 'invalid baseURL') }
    if (!HTTP_PROTOCOLS.includes(url.protocol) || url.username || url.password || url.hash) catalogError(path, 'invalid baseURL')
  }
  if ('headers' in raw) headers(raw.headers, path + '.headers')
  if ('transport' in raw && (!TRANSPORTS.includes(raw.transport as string) || source?.id !== CODEX_SOURCE)) {
    catalogError(path + '.transport', 'transport requires openai-codex and a supported mode')
  }
  if ('fallbackSessionId' in raw) {
    catalogString(raw.fallbackSessionId, path + '.fallbackSessionId')
    if (source?.id !== GO_SOURCE) catalogError(path, 'fallbackSessionId requires opencode-go source')
  }
  if (source === undefined && !('baseURL' in raw)) catalogError(path + '.baseURL', 'a route with no installed source must declare its endpoint')
  if (('models' in raw) === ('filter' in raw)) catalogError(path, 'declare exactly one of models or filter')
  const declarations = 'filter' in raw ? undefined : raw.models
  if (declarations !== undefined && !Array.isArray(declarations)) catalogError(path + '.models', 'expected an explicit array')
  if ('filter' in raw && source === undefined) catalogError(path + '.filter', 'filter expands the catalog of an installed source')
  const installed = source?.getModels()
  const names = new Set<string>()
  const configuredMaxTokens = new Map<string, number>()
  const models = declarations === undefined
    ? filteredModels(raw.filter, source!, input, path + '.filter')
    : declarations.map((entry, index): Model<Api> => {
    const location = path + '.models[' + index + ']'
    const spec = catalogRecord(entry, MODEL_FIELDS, location)
    catalogString(spec.id, location + '.id')
    catalogString(spec.name, location + '.name')
    const aliases = 'aliases' in spec ? strings(spec.aliases, location + '.aliases') : []
    for (const name of [spec.id, ...aliases]) {
      if (names.has(name)) catalogError(location, 'duplicate model id or alias ' + name)
      names.add(name)
    }
    if ('template' in spec) catalogString(spec.template, location + '.template')
    const template = installed?.find(model => model.id === (spec.template ?? spec.id))
    if ('template' in spec && !template) catalogError(location, 'unknown template ' + spec.template)
    if ('metadata' in spec) metadata(spec.metadata, template?.api ?? declaredApi, location + '.metadata')
    const overrides = spec.metadata as Partial<Model<Api>> | undefined
    if (!template) {
      for (const key of REQUIRED_METADATA) {
        // A route with no installed source states the protocol once, for every model it serves.
        if (key === 'api' && declaredApi !== undefined) continue
        if (!overrides || !(key in overrides)) catalogError(location, 'unknown model requires complete metadata: missing ' + key)
      }
    }
    if ('defaultMaxTokens' in spec) {
      number(spec.defaultMaxTokens, location + '.defaultMaxTokens', true)
      const limit = spec.defaultMaxTokens as number
      if (limit > (overrides?.maxTokens ?? template!.maxTokens)) {
        catalogError(location + '.defaultMaxTokens', 'exceeds model maxTokens')
      }
      configuredMaxTokens.set(spec.id, limit)
    }
    const api = overrides?.api ?? template?.api ?? declaredApi
    // Inherited compatibility and thinking metadata belong to the template's protocol.
    if (template && api !== template.api) catalogError(location + '.metadata.api', 'cannot change a template-backed protocol')
    if (declaredApi !== undefined && api !== declaredApi) catalogError(location + '.metadata.api', 'a route with no installed source speaks its declared protocol')
    if (installed !== undefined && !installed.some(model => model.api === api)) catalogError(location, 'source does not describe API ' + api)
    const baseUrl = input.baseURL ?? template?.baseUrl ?? source?.baseUrl
    if (baseUrl === undefined) catalogError(location, 'unknown model requires provider baseURL')
    return freezeCatalogValue(structuredClone({ ...template, ...overrides, id: spec.id, name: spec.name, api, provider: input.id, baseUrl }) as Model<Api>)
  })
  const config = freezeCatalogValue(structuredClone(input))
  // A route with no installed source borrows no vendor behavior: pi-ai's own
  // implementation for the declared protocol streams it, under this route's facts.
  const routed: Provider = source === undefined
    ? createProvider({
        id: config.id, name: config.name, baseUrl: config.baseURL, headers: config.headers,
        auth: { apiKey: harnessApiKeyAuth(config.name) },
        models: freezeCatalogValue(models), api: PROTOCOL_STREAMS[declaredApi!]!,
      })
    : {
        id: config.id, name: config.name, baseUrl: config.baseURL ?? source.baseUrl,
        auth: detachedAuth(source.auth),
        getModels: () => freezeCatalogValue(models),
        stream: (model, context, options) => source.stream(model, context, routeOptions(options, config)),
        streamSimple: (model, context, options) => source.streamSimple(model, context, routeOptions(options, config)),
      }
  return freezeCatalogValue({
    provider: config.id, displayName: config.name,
    ...(config.auth !== undefined && 'apiKeyRef' in config.auth ? { apiKeyEnv: credentialRef(config.auth.apiKeyRef) } : {}),
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.transport === undefined ? {} : { transport: config.transport }),
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS, maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET, requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, ERROR_PREFIX + config.id),
    modelErrors: catalogMap<string, string>([]), configuredMaxTokens: catalogMap(configuredMaxTokens), piProvider: routed,
  })
}
