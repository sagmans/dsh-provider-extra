/** Keep paid request policy with the route owner, never with a terminal-only selector. */
import type { Context } from '@deepseek-ai/cordis'
import { mountTierActions } from './tui-actions.ts'
import { mountTierRemote } from './tier-remote.ts'
import { createTierStore } from './tier-store.ts'
import { currentInvocationTier, mountTierInvocation } from './tier-invocation.ts'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Api, Model, StreamOptions } from '@earendil-works/pi-ai'

/** Source and protocol must agree before a route can request paid processing. */
export const CODEX_TIER_API = 'openai-codex-responses'
const CODEX_SOURCE = 'openai-codex'
const OPENAI_SOURCE = 'openai'
const AUTO_TIER = 'auto'
const OPENAI_TIER_APIS: readonly Api[] = ['openai-responses', 'openai-completions']
/** Keep saved choices stable while each native protocol resolves its own wire policy. */
export const SERVICE_TIER_CHOICES = [
  { id: AUTO_TIER, name: 'Auto', description: 'Use the account service tier' },
  { id: 'default', name: 'Standard', description: 'Standard processing' },
  { id: 'priority', name: 'Fast', description: 'Priority processing; higher usage cost, subject to account access' },
] as const
const SERVICE_NAME = 'providerServiceTiers'
const PROFILE_SERVICE = 'profileContext'
const INVOCATION_TIERS = new Map<string, string | null>([
  ['fast', 'priority'],
  ['standard', 'default'],
  ['provider-default', null],
])
const INVALID_TIER = 'unsupported service tier for this model route'
const INVALID_PAYLOAD = 'OpenAI service tier requires an object request payload'

/** A model-scoped policy must not leak into unrelated routes or models. */
export interface TierSelectionEntry { provider: string; model: string; tier: string }
/** The same profile owner validates membership and paid processing policy together. */
export interface TierSelectionConfig { serviceTierSelections?: readonly TierSelectionEntry[] }
/** Structural contract lets any surface select tiers without importing this plugin. */
export interface TierSelection {
  choices(provider: string, model: string): readonly { id: string; name: string; description: string }[]
  current(provider: string, model: string): string | undefined
  /** Invocation policy must validate without changing shared selections. */
  resolve(provider: string, model: string, override: string): string | null
  select(provider: string, model: string, tier: string | undefined): Promise<void>
}
declare module '@deepseek-ai/cordis' {
  interface Context { providerServiceTiers: TierSelection }
}

/** Catalog aliases retain source identity; protocol compatibility alone conveys no tier support. */
type TierSourceResolver = (provider: string) => string | undefined

/** Standalone helpers may use native route ids; mounted owners must supply authoritative sources. */
const routeIdentity: TierSourceResolver = provider => provider

/** OpenAI-compatible gateways must not inherit native account billing policy. */
function supportsTiers(source: string | undefined, api: Api): boolean {
  return source === CODEX_SOURCE ? api === CODEX_TIER_API
    : source === OPENAI_SOURCE && OPENAI_TIER_APIS.includes(api)
}

/** Reject stale or hand-edited values before they become request parameters. */
function validTier(tier: string): boolean {
  return SERVICE_TIER_CHOICES.some(choice => choice.id === tier)
}

/** Startup validation shares the same canonical values and aliases as model-scoped resolution. */
export function isServiceTierOverride(value: string): boolean {
  return validTier(value) || INVOCATION_TIERS.has(value)
}

/** Durable writes complete before the selected row can truthfully report success. */
export function createTierSelection(
  read: (provider: string, model: string) => string | null | undefined,
  write: (provider: string, model: string, tier: string | null) => Promise<void>,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  sourceFor: TierSourceResolver = routeIdentity,
): TierSelection {
  const choices = (provider: string, model: string): typeof SERVICE_TIER_CHOICES | readonly [] =>
    profiles().get(provider)?.piProvider?.getModels().some(entry => entry.id === model && supportsTiers(sourceFor(provider), entry.api))
      ? SERVICE_TIER_CHOICES : []
  return {
    choices,
    resolve: (provider, model, override) => {
      const available = choices(provider, model)
      const tier = INVOCATION_TIERS.has(override) ? INVOCATION_TIERS.get(override)! : override
      if (available.length === 0 || (tier !== null && !available.some(choice => choice.id === tier))) throw new Error(INVALID_TIER)
      return tier
    },
    current: (provider, model) => {
      const tier = read(provider, model)
      return typeof tier === 'string' && validTier(tier) ? tier : undefined
    },
    select: async (provider, model, tier) => {
      if (choices(provider, model).length === 0 || (tier !== undefined && !validTier(tier))) throw new Error(INVALID_TIER)
      await write(provider, model, tier ?? null)
    },
  }
}

/** Decorate native streams so existing auth, routing, transport, and replay survive. */
export function withServiceTiers(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  current: (provider: string, model: string) => string | undefined,
  sourceFor: TierSourceResolver = routeIdentity,
): Map<string, ResolvedPiAiProviderProfile> {
  return new Map([...profiles].map(([id, profile]) => {
    const source = profile.piProvider
    const eligible = (model: Model<Api>): boolean => supportsTiers(sourceFor(id), model.api)
    if (source === undefined || !source.getModels().some(eligible)) return [id, profile]
    const optionsFor = <T extends StreamOptions>(model: Model<Api>, options: T | undefined): T | undefined => {
      // Plugin-local request scope carries CLI policy without changing host request or session schemas.
      const invocation = currentInvocationTier()
      const override = invocation === undefined
        ? (options as (T & { serviceTier?: string | null }) | undefined)?.serviceTier : invocation
      if (override === null) {
        if (options === undefined) return undefined
        const forwarded = Object.assign({}, options)
        delete (forwarded as { serviceTier?: string | null }).serviceTier
        return forwarded
      }
      const tier = override ?? current(id, model.id)
      if (!eligible(model) || tier === undefined || !validTier(tier)) return options
      // Codex rejects literal auto; omission delegates to the account without changing the saved choice.
      const wireTier = model.api === CODEX_TIER_API && tier === AUTO_TIER ? undefined : tier
      return Object.assign({}, options, { serviceTier: wireTier, onPayload: async (payload: unknown, wireModel: Model<Api>) => {
        // pi-ai's simple stream drops serviceTier, but retains this final serialization hook.
        const replacement = await options?.onPayload?.(payload, wireModel)
        const body = replacement === undefined ? payload : replacement
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error(INVALID_PAYLOAD)
        const forwarded: Record<string, unknown> = { ...body }
        if (wireTier === undefined) delete forwarded.service_tier
        else forwarded.service_tier = wireTier
        return forwarded
      } })
    }
    return [id, { ...profile, piProvider: {
      ...source,
      stream: (model, context, options) => source.stream(model, context, optionsFor(model, options)),
      streamSimple: (model, context, options) => source.streamSimple(model, context, optionsFor(model, options)),
    } }]
  }))
}

/** Plugin-owned records share selections without editing or reconciling profile configuration. */
export function mountServiceTiers(
  ctx: Context,
  config: TierSelectionConfig,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  sourceFor: TierSourceResolver = routeIdentity,
): TierSelection {
  const profile = ctx.get(PROFILE_SERVICE) as { home?: string } | undefined
  const store = createTierStore(profile?.home, validTier)
  const service = createTierSelection(
    (provider, model) => {
      const tier = store.read(provider, model)
      return tier === undefined
        ? config.serviceTierSelections?.find(entry => entry.provider === provider && entry.model === model)?.tier
        : tier
    },
    store.write,
    profiles,
    sourceFor,
  )
  ctx.provide(SERVICE_NAME, service)
  mountTierInvocation(ctx, service)
  mountTierRemote(ctx)
  mountTierActions(ctx, service)
  return service
}
