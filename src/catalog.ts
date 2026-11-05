/** Managed configuration owns route identity and selection, never provider discovery. */

import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type {
  AnthropicMessagesCompat,
  Api,
  Model,
  ModelThinkingLevel,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  Provider,
  Transport,
} from '@earendil-works/pi-ai'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import {
  buildCatalogProfile,
  catalogError,
  catalogMap,
  catalogRecord,
  catalogString,
  freezeCatalogValue,
} from './catalog-routes.ts'

const CONFIG_VERSION = 1
const CONFIG_FIELDS = ['version', 'providers', 'default']
const SELECTION_FIELDS = ['provider', 'model', 'reasoningEffort']
const OUTSIDE_SELECTION = 'provider/model is outside the managed selection'

/** Credentials stay symbolic until request time. */
export type CatalogAuth = { apiKeyRef: string } | { credentialProvider: string }
/** Managed sources expose protocol flags, not unrelated gateway routing or template-language configuration. */
export type CatalogModelCompat =
  | Omit<
      OpenAICompletionsCompat,
      | 'chatTemplateKwargs'
      | 'chatTemplateArgs'
      | 'openRouterRouting'
      | 'vercelGatewayRouting'
      | 'vllmPriority'
    >
  | OpenAIResponsesCompat
  | Omit<AnthropicMessagesCompat, 'allowedFallbackModels'>
/** Wire identity and arbitrary sampling payloads cannot be overwritten through metadata. */
export type CatalogModelMetadata = Partial<
  Pick<
    Model<Api>,
    | 'api'
    | 'reasoning'
    | 'input'
    | 'cost'
    | 'contextWindow'
    | 'maxTokens'
    | 'thinkingLevelMap'
    | 'headers'
  >
> & { compat?: CatalogModelCompat }
/** Aliases are selector inputs, never additional wire models. */
export interface CatalogModel {
  id: string
  name: string
  aliases?: string[]
  template?: string
  metadata?: CatalogModelMetadata
  /** Explicit migrated request policy must not be inferred from model capacity. */
  defaultMaxTokens?: number
}
/** Host-compatible selection, with aliases normalized to wire identity. */
export interface CatalogSelection {
  provider: string
  model: string
  reasoningEffort?: ModelThinkingLevel
}
/** Curated membership without restating every entry the installed source publishes. */
export interface CatalogFilter {
  include?: string[]
  exclude?: string[]
}
/**
 * Membership is the profile's alone. A route either borrows an installed
 * backend's protocol, or declares its own protocol and endpoint; `models`
 * lists the selection and `filter` curates it by pattern.
 */
export interface CatalogProvider {
  id: string
  name: string
  source?: string
  /** Wire protocol of a route that names no installed source. */
  api?: string
  /** Absent means the route carries no key of its own, as a local endpoint does. */
  auth?: CatalogAuth
  models?: CatalogModel[]
  filter?: CatalogFilter
  baseURL?: string
  headers?: Record<string, string>
  transport?: Transport
  fallbackSessionId?: string
}
/** An explicit null default is valid only when no selected models exist. */
export interface CatalogConfig {
  version: 1
  providers: CatalogProvider[]
  default: CatalogSelection | null
}
/** Runtime freezing protects retained requests even though adapter types use mutable records. */
export interface CatalogSnapshot {
  readonly config: CatalogConfig
  readonly profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  readonly providers: ReadonlyMap<string, CatalogProvider>
  readonly selection: CatalogSelection | null
  resolveSelection(input: unknown): CatalogSelection
}

/** Every route was just compiled into a profile, so a miss is a broken catalog and must not load. */
function servedProvider(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  id: string,
): Provider {
  const provider = profiles.get(id)?.piProvider
  if (provider === undefined) catalogError('providers', `no loaded provider for ${id}`)
  return provider
}

/** The served model a selection names; a name the route does not serve is outside the catalog. */
function servedModel(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  provider: string,
  modelId: string | undefined,
): ReturnType<Provider['getModels']>[number] {
  if (modelId === undefined) catalogError('selection', OUTSIDE_SELECTION)
  const model = servedProvider(profiles, provider)
    .getModels()
    .find((candidate) => candidate.id === modelId)
  if (model === undefined) catalogError('selection', OUTSIDE_SELECTION)
  return model
}

/** Every name a route answers to, each mapped to the model id it reaches. */
function routeAliases(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  provider: CatalogConfig['providers'][number],
): Map<string, string> {
  const names = new Map<string, string>()
  // Served models, not declarations: a filtered route owns ids it never spells out.
  for (const model of servedProvider(profiles, provider.id).getModels())
    names.set(model.id, model.id)
  for (const model of provider.models ?? []) {
    for (const alias of model.aliases ?? []) names.set(alias, model.id)
  }
  return names
}

/** Absence keeps legacy ownership separate from a managed empty catalog. */
export function compileCatalog(config: unknown): CatalogSnapshot | undefined {
  if (config === undefined) return undefined
  const raw = catalogRecord(config, CONFIG_FIELDS, 'config')
  if (raw.version !== CONFIG_VERSION) catalogError('version', 'expected version 1')
  if (!Array.isArray(raw.providers)) catalogError('providers', 'expected an explicit array')
  const profiles = new Map<string, ResolvedPiAiProviderProfile>()
  for (const declaration of raw.providers) {
    const profile = buildCatalogProfile(declaration)
    if (profiles.has(profile.provider))
      catalogError('providers', `duplicate provider ${profile.provider}`)
    profiles.set(profile.provider, profile)
  }
  const normalized = structuredClone(raw) as unknown as CatalogConfig
  const providers = catalogMap(
    normalized.providers.map((provider) => [provider.id, provider] as const),
  )
  const aliases = new Map(
    normalized.providers.map(
      (provider) => [provider.id, routeAliases(profiles, provider)] as const,
    ),
  )
  const count = normalized.providers.reduce(
    (served, provider) => served + servedProvider(profiles, provider.id).getModels().length,
    0,
  )
  const resolveSelection = (input: unknown): CatalogSelection => {
    const candidate = catalogRecord(input, SELECTION_FIELDS, 'selection')
    catalogString(candidate.provider, 'selection.provider')
    catalogString(candidate.model, 'selection.model')
    const modelId = aliases.get(candidate.provider)?.get(candidate.model)
    const model = servedModel(profiles, candidate.provider, modelId)
    if (
      'reasoningEffort' in candidate &&
      !getSupportedThinkingLevels(model).includes(candidate.reasoningEffort as ModelThinkingLevel)
    ) {
      catalogError('selection.reasoningEffort', 'effort is not supported by the selected model')
    }
    return freezeCatalogValue({
      provider: candidate.provider,
      model: model.id,
      ...('reasoningEffort' in candidate
        ? { reasoningEffort: candidate.reasoningEffort as ModelThinkingLevel }
        : {}),
    })
  }
  if (count === 0) {
    if (normalized.default !== null) catalogError('default', 'empty catalog requires null')
  } else normalized.default = resolveSelection(normalized.default)
  return freezeCatalogValue({
    config: normalized,
    profiles: catalogMap(profiles),
    providers,
    selection: normalized.default,
    resolveSelection,
  })
}
