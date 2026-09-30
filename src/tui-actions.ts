/** Terminal shortcuts and follow-up policy belong to the provider that advertises the paid choices. */
import type { Context } from '@deepseek-ai/cordis'
import type { TierSelection } from './service-tiers.ts'

const REGISTRY = 'tuiKeymaps'
export const TIER_ACTION_ID = 'plugin.provider-extra.serviceTier'
const TIER_KEY = 't'
const TIER_LABEL = 'service tier'
const PROVIDER_DEFAULT = ''
const SAVE_FAILURE = 'could not save service tier; check writable provider settings and retry'
const DISCOVERY_FAILURE = 'could not read service tiers; check provider configuration and retry'
const NO_ROUTE = 'no model route is in use; choose a model first'
const UNSUPPORTED = 'this model route advertises no service tiers'

/** Structural ports make terminal integration optional without adding a TUI dependency. */
export interface TierActionPorts {
  route: { provider: string; model: string } | undefined
  pick(spec: { title: string; rows: readonly { id: string; name: string; description?: string; current?: boolean }[] }): Promise<string | undefined>
  notice(message: string): void
}
interface Registry {
  register(owner: Context, action: { id: string; layer: 'chord'; defaultKeys: readonly string[]; label: string; handler(ports: TierActionPorts): Promise<void> }): () => void
  afterEffort(owner: Context, handler: (ports: TierActionPorts) => Promise<void>): () => void
}

/** The captured owner lasts exactly as long as its scoped registration, including Config reconciliation. */
export function createTierPicker(tiers: TierSelection): (ports: TierActionPorts, quiet?: boolean) => Promise<void> {
  let opening = false
  return async (ports, quiet = false) => {
    if (opening) return
    opening = true
    let saving = false
    try {
      const route = ports.route
      if (route === undefined) { if (!quiet) ports.notice(NO_ROUTE); return }
      const choices = tiers.choices(route.provider, route.model)
      if (choices.length === 0) { if (!quiet) ports.notice(UNSUPPORTED); return }
      const current = tiers.current(route.provider, route.model)
      const rows = [
        { id: PROVIDER_DEFAULT, name: 'provider default', description: 'clear the explicit service tier', current: current === undefined },
        ...choices.map(choice => ({ ...choice, current: choice.id === current })),
      ]
      const picked = await ports.pick({ title: TIER_LABEL + ' · ' + route.provider + '/' + route.model, rows })
      if (picked === undefined) return
      if (!rows.some(row => row.id === picked)) throw new Error(DISCOVERY_FAILURE)
      saving = true
      await tiers.select(route.provider, route.model, picked === PROVIDER_DEFAULT ? undefined : picked)
      ports.notice(TIER_LABEL + ' set to ' + (picked === PROVIDER_DEFAULT ? 'provider default' : picked) + ' for the next request')
    } catch { ports.notice(saving ? SAVE_FAILURE : DISCOVERY_FAILURE) }
    finally { opening = false }
  }
}

/** Optional injection leaves console and web profiles independent of the terminal bundle. */
export function mountTierActions(ctx: Context, tiers: TierSelection): void {
  ctx.inject([REGISTRY], owner => {
    const registry = owner.get(REGISTRY) as Registry
    const choose = createTierPicker(tiers)
    registry.register(owner, { id: TIER_ACTION_ID, layer: 'chord', defaultKeys: [TIER_KEY], label: TIER_LABEL,
      handler: ports => choose(ports) })
    registry.afterEffort(owner, ports => choose(ports, true))
  })
}
