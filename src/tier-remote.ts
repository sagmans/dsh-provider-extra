/** The existing admitted-peer gateway owns transport and authorization, as for settings. */
import type { Context } from '@deepseek-ai/cordis'
import type { TierSelection } from './service-tiers.ts'
import { TIER_CONTRIBUTION, TIER_NAMESPACE, TIER_SAVE_ERROR, parseTier, parseTierIdentity, parseTierView, type TierView } from './tier-client.ts'

const TYPERT_SERVICE = 'typert'
const TIER_SERVICE = 'providerServiceTiers'
const UNSUPPORTED = 'Service tier is unsupported for this model route'
const HOST_CONTRIBUTION = {
  package: TIER_CONTRIBUTION.package,
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: TIER_CONTRIBUTION.descriptors,
} as const
interface TypertPort { register(contribution: typeof HOST_CONTRIBUTION): () => Promise<void> }

/** Fresh Context lookups preserve provider replacement and HMR semantics. */
class TierRemote {
  readonly typertRemote = { service: this, serviceKey: TIER_NAMESPACE, namespace: TIER_NAMESPACE }
  constructor(readonly ctx: Context) {}

  /** Do not expose provider internals alongside the public capability view. */
  async describe(provider: unknown, model: unknown, signal?: AbortSignal): Promise<TierView> {
    signal?.throwIfAborted()
    const providerId = parseTierIdentity(provider)
    const modelId = parseTierIdentity(model)
    const tiers = this.ctx.get(TIER_SERVICE) as Pick<TierSelection, 'choices' | 'current' | 'select'>
    const choices = tiers.choices(providerId, modelId).map(({ id, name, description }) => ({ id, name, description }))
    const current = choices.length === 0 ? undefined : tiers.current(providerId, modelId)
    return parseTierView({ choices, ...(current === undefined ? {} : { current }) })
  }

  /** Capability validation precedes mutation; persistence failures reveal no paths or secrets. */
  async select(provider: unknown, model: unknown, tier?: unknown, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const providerId = parseTierIdentity(provider)
    const modelId = parseTierIdentity(model)
    const selected = parseTier(tier)
    const tiers = this.ctx.get(TIER_SERVICE) as Pick<TierSelection, 'choices' | 'current' | 'select'>
    const choices = tiers.choices(providerId, modelId)
    if (choices.length === 0 || (selected !== undefined && !choices.some(choice => choice.id === selected))) throw new Error(UNSUPPORTED)
    try { await tiers.select(providerId, modelId, selected) }
    catch { signal?.throwIfAborted(); throw new Error(TIER_SAVE_ERROR) }
    signal?.throwIfAborted()
  }
}

/** Older or terminal-only hosts do not need Typert to use provider tier policy. */
export function mountTierRemote(ctx: Context): void {
  ctx.inject([TYPERT_SERVICE, TIER_SERVICE], owner => {
    owner.provide(TIER_NAMESPACE, new TierRemote(owner) as never)
    const typert = owner.get(TYPERT_SERVICE) as unknown as TypertPort
    // Host dispatch reads local invocations; remotes.register owns only consumer descriptors.
    owner.effect(() => typert.register(HOST_CONTRIBUTION))
  })
}
