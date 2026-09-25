/** Installed providers retain protocol and auth ownership; managed routes own selected model facts. */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Api, Model, Provider, StreamOptions } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { CatalogProvider } from './catalog.ts'

const ERROR_PREFIX = 'dsh-provider-extra: catalog '
const ROUTE_FIELDS = ['id', 'name', 'source', 'auth', 'models', 'baseURL', 'headers', 'transport', 'fallbackSessionId']
const MODEL_FIELDS = ['id', 'name', 'aliases', 'template', 'metadata', 'defaultMaxTokens']
const METADATA_FIELDS = ['api', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'headers', 'compat']
const REQUIRED_METADATA = ['api', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens']
const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite']
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const TRANSPORTS = ['sse', 'websocket', 'websocket-cached', 'auto']
const GO_SOURCE = 'opencode-go'
const CODEX_SOURCE = 'openai-codex'
const SOURCES = ['openai', CODEX_SOURCE, GO_SOURCE, 'qwen-token-plan', 'xai']
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

/** A standalone builder validates its complete declaration before constructing any adapter profile. */
export function buildCatalogProfile(input: CatalogProvider): ResolvedPiAiProviderProfile {
  const path = 'provider'
  const raw = catalogRecord(input, ROUTE_FIELDS, path)
  for (const key of ['id', 'name', 'source']) catalogString(raw[key], path + '.' + key)
  if (!SOURCES.includes(raw.source as string)) catalogError(path + '.source', 'unsupported managed source ' + raw.source)
  const source = builtinProviders().find(provider => provider.id === raw.source)
  if (!source) catalogError(path + '.source', 'unknown installed provider ' + raw.source)
  const auth = catalogRecord(raw.auth, ['apiKeyRef', 'credentialProvider'], path + '.auth')
  if (Object.keys(auth).length !== 1) catalogError(path + '.auth', 'choose exactly one credential mode')
  if ('apiKeyRef' in auth) {
    if (source.id === CODEX_SOURCE) catalogError(path + '.auth', 'openai-codex requires credentialProvider OAuth')
    catalogString(auth.apiKeyRef, path + '.auth.apiKeyRef')
    credentialRef(auth.apiKeyRef)
  } else if (auth.credentialProvider !== source.id) catalogError(path + '.auth', 'credentialProvider must equal source')
  if ('baseURL' in raw) {
    catalogString(raw.baseURL, path + '.baseURL')
    let url: URL
    try { url = new URL(raw.baseURL) } catch { catalogError(path, 'invalid baseURL') }
    if (!HTTP_PROTOCOLS.includes(url.protocol) || url.username || url.password || url.hash) catalogError(path, 'invalid baseURL')
  }
  if ('headers' in raw) headers(raw.headers, path + '.headers')
  if ('transport' in raw && (!TRANSPORTS.includes(raw.transport as string) || source.id !== CODEX_SOURCE)) {
    catalogError(path + '.transport', 'transport requires openai-codex and a supported mode')
  }
  if ('fallbackSessionId' in raw) {
    catalogString(raw.fallbackSessionId, path + '.fallbackSessionId')
    if (source.id !== GO_SOURCE) catalogError(path, 'fallbackSessionId requires opencode-go source')
  }
  if (!Array.isArray(raw.models)) catalogError(path + '.models', 'expected an explicit array')
  const installed = source.getModels()
  const names = new Set<string>()
  const configuredMaxTokens = new Map<string, number>()
  const models = raw.models.map((entry, index): Model<Api> => {
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
    const template = installed.find(model => model.id === (spec.template ?? spec.id))
    if ('template' in spec && !template) catalogError(location, 'unknown template ' + spec.template)
    if ('metadata' in spec) metadata(spec.metadata, template?.api, location + '.metadata')
    const overrides = spec.metadata as Partial<Model<Api>> | undefined
    if (!template) {
      for (const key of REQUIRED_METADATA) {
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
    const api = overrides?.api ?? template?.api
    // Inherited compatibility and thinking metadata belong to the template's protocol.
    if (template && api !== template.api) catalogError(location + '.metadata.api', 'cannot change a template-backed protocol')
    if (!installed.some(model => model.api === api)) catalogError(location, 'source does not describe API ' + api)
    const baseUrl = input.baseURL ?? template?.baseUrl ?? source.baseUrl
    if (baseUrl === undefined) catalogError(location, 'unknown model requires provider baseURL')
    return freezeCatalogValue(structuredClone({ ...template, ...overrides, id: spec.id, name: spec.name, provider: input.id, baseUrl }) as Model<Api>)
  })
  const config = freezeCatalogValue(structuredClone(input))
  const routed: Provider = {
    id: config.id, name: config.name, baseUrl: config.baseURL ?? source.baseUrl,
    auth: detachedAuth(source.auth),
    getModels: () => freezeCatalogValue(models),
    stream: (model, context, options) => source.stream(model, context, routeOptions(options, config)),
    streamSimple: (model, context, options) => source.streamSimple(model, context, routeOptions(options, config)),
  }
  return freezeCatalogValue({
    provider: config.id, displayName: config.name,
    ...('apiKeyRef' in config.auth ? { apiKeyEnv: credentialRef(config.auth.apiKeyRef) } : {}),
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.transport === undefined ? {} : { transport: config.transport }),
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS, maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET, requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, ERROR_PREFIX + config.id),
    modelErrors: catalogMap<string, string>([]), configuredMaxTokens: catalogMap(configuredMaxTokens), piProvider: routed,
  })
}
