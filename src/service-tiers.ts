/** Keep paid request policy with the route owner, never with a terminal-only selector. */
import type { Context } from '@deepseek-ai/cordis'
import { mountTierActions } from './tui-actions.ts'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Api, Model, StreamOptions } from '@earendil-works/pi-ai'

/** Protocol identity protects ordinary OpenAI API routes from subscription-only policy. */
export const CODEX_TIER_API = 'openai-codex-responses'
/** Limit paid policies to choices the Codex request transport recognizes. */
export const SERVICE_TIER_CHOICES = [
  { id: 'auto', name: 'Auto', description: 'Use the account service tier' },
  { id: 'default', name: 'Standard', description: 'Standard processing' },
  { id: 'priority', name: 'Fast', description: 'Priority processing; higher usage cost, subject to account access' },
] as const
const SERVICE_TIER_FIELD = 'serviceTierSelections'
const SERVICE_NAME = 'providerServiceTiers'
const EDITOR_SERVICE = 'configEditor'
const WRITE_UNSUPPORTED = 'service tier could not be saved; writable provider settings are required'
const INVALID_TIER = 'unsupported service tier for this model route'
const INVALID_PAYLOAD = 'Codex service tier requires an object request payload'

/** A model-scoped policy must not leak into unrelated routes or models. */
export interface TierSelectionEntry { provider: string; model: string; tier: string }
/** The same profile owner validates membership and paid processing policy together. */
export interface TierSelectionConfig { serviceTierSelections?: readonly TierSelectionEntry[] }
/** Structural contract lets any surface select tiers without importing this plugin. */
export interface TierSelection {
  choices(provider: string, model: string): readonly { id: string; name: string; description: string }[]
  current(provider: string, model: string): string | undefined
  select(provider: string, model: string, tier: string | undefined): Promise<void>
}
declare module '@deepseek-ai/cordis' {
  interface Context { providerServiceTiers: TierSelection }
}

/** Reject stale or hand-edited values before they become request parameters. */
function validTier(tier: string): boolean {
  return SERVICE_TIER_CHOICES.some(choice => choice.id === tier)
}

/** Durable writes complete before the selected row can truthfully report success. */
export function createTierSelection(
  read: () => readonly TierSelectionEntry[],
  write: (change: (entries: readonly TierSelectionEntry[]) => TierSelectionEntry[]) => Promise<void>,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
): TierSelection {
  const choices = (provider: string, model: string): typeof SERVICE_TIER_CHOICES | readonly [] =>
    profiles().get(provider)?.piProvider?.getModels().some(entry => entry.id === model && entry.api === CODEX_TIER_API)
      ? SERVICE_TIER_CHOICES : []
  return {
    choices,
    current: (provider, model) => {
      const tier = read().find(entry => entry.provider === provider && entry.model === model)?.tier
      return tier !== undefined && validTier(tier) ? tier : undefined
    },
    select: async (provider, model, tier) => {
      if (choices(provider, model).length === 0 || (tier !== undefined && !validTier(tier))) throw new Error(INVALID_TIER)
      await write(entries => {
        const next = entries.filter(entry => entry.provider !== provider || entry.model !== model)
        if (tier !== undefined) next.push({ provider, model, tier })
        return next
      })
    },
  }
}

/** Decorate only Codex streams so existing auth, routing, transport, and replay survive. */
export function withServiceTiers(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  current: (provider: string, model: string) => string | undefined,
): Map<string, ResolvedPiAiProviderProfile> {
  return new Map([...profiles].map(([id, profile]) => {
    const source = profile.piProvider
    if (source === undefined || !source.getModels().some(model => model.api === CODEX_TIER_API)) return [id, profile]
    const optionsFor = <T extends StreamOptions>(model: Model<Api>, options: T | undefined): T | undefined => {
      const tier = current(id, model.id)
      if (model.api !== CODEX_TIER_API || tier === undefined || options === undefined) return options
      return { ...options, serviceTier: tier, onPayload: async (payload: unknown, wireModel: Model<Api>) => {
        // pi-ai's simple stream drops serviceTier, but retains this final serialization hook.
        const replacement = await options?.onPayload?.(payload, wireModel)
        const body = replacement === undefined ? payload : replacement
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error(INVALID_PAYLOAD)
        return { ...body, service_tier: tier }
      } }
    }
    return [id, { ...profile, piProvider: {
      ...source,
      stream: (model, context, options) => source.stream(model, context, optionsFor(model, options)),
      streamSimple: (model, context, options) => source.streamSimple(model, context, optionsFor(model, options)),
    } }]
  }))
}

/** The profile editor supplies locking, rollback, and canonical plugin reconciliation. */
export function mountServiceTiers(
  ctx: Context,
  config: TierSelectionConfig,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
): TierSelection {
  const entry: unknown = (ctx.fiber as typeof ctx.fiber & { entry?: unknown }).entry
  const service = createTierSelection(
    // Retained calls keep their mounted policy until the editor reconciles a new owner.
    () => config.serviceTierSelections ?? [],
    async change => {
      const editor = ctx.get(EDITOR_SERVICE) as { edit?(entry: unknown, change: (raw: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void> } | undefined
      if (entry === undefined || typeof editor?.edit !== 'function') throw new Error(WRITE_UNSUPPORTED)
      await editor.edit(entry, (raw, inherited) => {
        // Merge under the profile lock so another model's simultaneous choice survives.
        const previous = (raw[SERVICE_TIER_FIELD] ?? inherited[SERVICE_TIER_FIELD] ?? []) as TierSelectionEntry[]
        if (!Array.isArray(previous)) throw new Error(WRITE_UNSUPPORTED)
        return { ...raw, [SERVICE_TIER_FIELD]: change(previous) }
      })
    },
    profiles,
  )
  ctx.provide(SERVICE_NAME, service)
  mountTierActions(ctx, service)
  return service
}
