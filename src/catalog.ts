/** Managed configuration owns route identity and selection, never provider discovery. */
import type { Api, Model, ModelThinkingLevel, Transport, OpenAICompletionsCompat, OpenAIResponsesCompat, AnthropicMessagesCompat } from '@earendil-works/pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { buildCatalogProfile, catalogError, catalogMap, catalogRecord, catalogString, freezeCatalogValue } from './catalog-routes.ts'

const CONFIG_VERSION = 1
const CONFIG_FIELDS = ['version', 'providers', 'default']
const SELECTION_FIELDS = ['provider', 'model', 'reasoningEffort']

/** Credentials stay symbolic until request time. */
export type CatalogAuth = { apiKeyRef: string } | { credentialProvider: string }
/** Managed sources expose protocol flags, not unrelated gateway routing or template-language configuration. */
export type CatalogModelCompat =
  | Omit<OpenAICompletionsCompat, 'chatTemplateKwargs' | 'chatTemplateArgs' | 'openRouterRouting' | 'vercelGatewayRouting' | 'vllmPriority'>
  | OpenAIResponsesCompat
  | Omit<AnthropicMessagesCompat, 'allowedFallbackModels'>
/** Wire identity and arbitrary sampling payloads cannot be overwritten through metadata. */
export type CatalogModelMetadata = Partial<Pick<Model<Api>,
  'api' | 'reasoning' | 'input' | 'cost' | 'contextWindow' | 'maxTokens' | 'thinkingLevelMap' | 'headers'
>> & { compat?: CatalogModelCompat }
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
/** An installed source supplies protocol behavior, not permission to expand the selection. */
export interface CatalogProvider {
  id: string
  name: string
  source: string
  auth: CatalogAuth
  models: CatalogModel[]
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

/** Absence keeps legacy ownership separate from a managed empty catalog. */
export function compileCatalog(config: unknown): CatalogSnapshot | undefined {
  if (config === undefined) return undefined
  const raw = catalogRecord(config, CONFIG_FIELDS, 'config')
  if (raw.version !== CONFIG_VERSION) catalogError('version', 'expected version 1')
  if (!Array.isArray(raw.providers)) catalogError('providers', 'expected an explicit array')
  const profiles = new Map<string, ResolvedPiAiProviderProfile>()
  for (const declaration of raw.providers) {
    const profile = buildCatalogProfile(declaration)
    if (profiles.has(profile.provider)) catalogError('providers', 'duplicate provider ' + profile.provider)
    profiles.set(profile.provider, profile)
  }
  const normalized = structuredClone(raw) as unknown as CatalogConfig
  const providers = catalogMap(normalized.providers.map(provider => [provider.id, provider] as const))
  const aliases = new Map<string, Map<string, string>>()
  let count = 0
  for (const provider of normalized.providers) {
    const routeAliases = new Map<string, string>()
    for (const model of provider.models) {
      routeAliases.set(model.id, model.id)
      for (const alias of model.aliases ?? []) routeAliases.set(alias, model.id)
      count++
    }
    aliases.set(provider.id, routeAliases)
  }
  const resolveSelection = (input: unknown): CatalogSelection => {
    const candidate = catalogRecord(input, SELECTION_FIELDS, 'selection')
    catalogString(candidate.provider, 'selection.provider')
    catalogString(candidate.model, 'selection.model')
    const modelId = aliases.get(candidate.provider)?.get(candidate.model)
    if (modelId === undefined) catalogError('selection', 'provider/model is outside the managed selection')
    const model = profiles.get(candidate.provider)!.piProvider!.getModels().find(model => model.id === modelId)!
    if ('reasoningEffort' in candidate && !getSupportedThinkingLevels(model).includes(candidate.reasoningEffort as ModelThinkingLevel)) {
      catalogError('selection.reasoningEffort', 'effort is not supported by the selected model')
    }
    return freezeCatalogValue({
      provider: candidate.provider, model: modelId,
      ...('reasoningEffort' in candidate ? { reasoningEffort: candidate.reasoningEffort as ModelThinkingLevel } : {}),
    })
  }
  if (count === 0) {
    if (normalized.default !== null) catalogError('default', 'empty catalog requires null')
  } else normalized.default = resolveSelection(normalized.default)
  return freezeCatalogValue({
    config: normalized, profiles: catalogMap(profiles), providers,
    selection: normalized.default, resolveSelection,
  })
}
