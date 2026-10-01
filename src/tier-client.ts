/** One dependency-free runtime keeps Host and browser boundary validation identical. */
import type { Context } from '@deepseek-ai/cordis'

export const TIER_PACKAGE = '@sagmans/dsh-provider-extra'
export const TIER_NAMESPACE = 'providerExtraTiers'
export const TIER_DEFAULT = ''
const COMMAND_NAME = 'service-tier'
export const TIER_SAVE_ERROR = 'Could not confirm service tier; check writable shared storage, then reopen /service-tier before retrying'
const READ_ERROR = 'Could not load service tiers; reopen /service-tier to retry'
const INVALID_WIRE = 'Invalid service tier data'
const INVALID_CHOICE = 'Invalid service tier selection'
const ROW_LABEL = 'Service tier'
const DEFAULT_LABEL = 'Provider default'
const COMMAND_SERVICE = 'commandUi'
const MODEL_SERVICE = 'modelDirectories'
const SESSION_SERVICE = 'sessions'
const REMOTE_SERVICE = 'remote'
const TIER_REMOTE_SERVICE = REMOTE_SERVICE + '.' + TIER_NAMESPACE
const UNAVAILABLE = 'Service tiers are unavailable for this model or session'
const STALE_ROUTE = 'Model changed; reopen /service-tier before saving'
const COMMAND_DESCRIPTION = 'Choose the current model’s shared service tier'
const SEARCH_PLACEHOLDER = 'Search service tiers'
const NO_RESULTS = 'No matching service tiers'
const TIER_IDS = ['auto', 'default', 'priority'] as const

/** Wire choices preserve the provider owner's capability decision. */
export interface TierChoice { id: string; name: string; description: string }
/** Omitted current means provider policy, not an explicit Standard override. */
export interface TierView { choices: readonly TierChoice[]; current?: string }
/** Structural subsets mirror npm's public contracts without runtime or React imports. */
interface ClientSession { readonly sessionId: string }
interface SelectOption { readonly id: string; readonly label: string; readonly detail?: string; readonly active?: boolean }
interface CommandUi {
  register(contribution: {
    name: string
    label(): string
    description(): string
    available(session: ClientSession): boolean
    ui: {
      kind: 'popupSelect'
      searchLabels(): { placeholder: string; empty: string; noResults: string }
      options(session: ClientSession, signal: AbortSignal): Promise<readonly SelectOption[]>
      onSelect(option: SelectOption, session: ClientSession): Promise<void>
    }
  }): () => void
  dismiss(name: string): void
}
interface ModelState { current: { provider: string; model: string } | null; routable: boolean | null }
interface ModelDirectories {
  directoryFor(sessionId: string): {
    load(): Promise<ModelState>
    store: { getSnapshot(): ModelState; subscribe(listener: () => void): () => void }
  }
}
interface Sessions { subagentAddress(sessionId: string): unknown }
interface RemotePort {
  $mount(contribution: typeof TIER_CONTRIBUTION): Promise<() => Promise<void>>
  providerExtraTiers: {
    describe(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
    select(provider: string, model: string, tier: string | undefined, signal?: AbortSignal): Promise<unknown>
  }
}

/** Reject extra fields instead of forwarding accidental provider state. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) throw new TypeError(INVALID_WIRE)
  return value as Record<string, unknown>
}
/** Empty route identities cannot name a provider-owned capability. */
export function parseTierIdentity(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(INVALID_WIRE)
  return value
}
/** Only explicitly supported billing policies may cross this boundary. */
export function parseTier(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !TIER_IDS.some(id => id === value)) throw new TypeError(INVALID_WIRE)
  return value
}
/** Both gateway output and browser input require a complete, consistent view. */
export function parseTierView(value: unknown): TierView {
  const input = record(value, ['choices', 'current'])
  if (!Array.isArray(input.choices)) throw new TypeError(INVALID_WIRE)
  const choices = input.choices.map(value => {
    const choice = record(value, ['id', 'name', 'description'])
    const id = parseTier(choice.id)
    if (id === undefined) throw new TypeError(INVALID_WIRE)
    return { id, name: parseTierIdentity(choice.name), description: parseTierIdentity(choice.description) }
  })
  const ids = new Set(choices.map(choice => choice.id))
  if (ids.size !== choices.length) throw new TypeError(INVALID_WIRE)
  const current = parseTier(input.current)
  if (current !== undefined && !ids.has(current)) throw new TypeError(INVALID_WIRE)
  return { choices, ...(current === undefined ? {} : { current }) }
}
/** A successful write returns no unvalidated provider details. */
function parseVoid(value: unknown): undefined {
  if (value !== undefined) throw new TypeError(INVALID_WIRE)
  return undefined
}
/** Typert needs only parse; importing a schema library would add browser dependencies. */
function strict<Output>(typeSymbol: string, parse: (value: unknown) => Output) {
  return { mode: 'strict' as const, typeSymbol, create: () => ({ parse }), decode: parse }
}
const IDENTITY_CODEC = strict(TIER_PACKAGE + '.TierIdentity', parseTierIdentity)
const TIER_CODEC = strict(TIER_PACKAGE + '.TierSelection', parseTier)
const VIEW_CODEC = strict(TIER_PACKAGE + '.TierView', parseTierView)
const VOID_CODEC = strict('void', parseVoid)
const ROUTE_PARAMETERS = [
  { name: 'provider', wire: 'provider', source: 'json', codec: IDENTITY_CODEC },
  { name: 'model', wire: 'model', source: 'json', codec: IDENTITY_CODEC },
] as const
/** Explicit descriptors avoid a generator or a multi-module browser bundler. */
export const TIER_CONTRIBUTION = {
  package: TIER_PACKAGE,
  descriptors: [
    { id: TIER_NAMESPACE + '/describe', service: TIER_NAMESPACE, namespace: TIER_NAMESPACE, method: 'describe',
      invocation: { kind: 'direct' }, parameters: ROUTE_PARAMETERS, cancellation: { parameter: 'signal' }, result: VIEW_CODEC },
    { id: TIER_NAMESPACE + '/select', service: TIER_NAMESPACE, namespace: TIER_NAMESPACE, method: 'select',
      invocation: { kind: 'direct' }, parameters: [...ROUTE_PARAMETERS,
        { name: 'tier', wire: 'tier', source: 'json', acceptsUndefined: true, codec: TIER_CODEC }],
      cancellation: { parameter: 'signal' }, result: VOID_CODEC },
  ],
} as const

/** Remote failures contain transport detail that must not become UI error text. */
function resultValue(result: unknown, message: string): unknown {
  if (result === null || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error(message)
  const envelope = record(result, ['ok', 'value'])
  return envelope.value
}

/** Optional injection keeps older hosts inert and scopes command ownership to HMR lifetime. */
export function apply(ctx: Context): void {
  ctx.inject([COMMAND_SERVICE, MODEL_SERVICE, SESSION_SERVICE, REMOTE_SERVICE], owner => {
    const command = owner.get(COMMAND_SERVICE) as CommandUi
    const models = owner.get(MODEL_SERVICE) as ModelDirectories
    const sessions = owner.get(SESSION_SERVICE) as unknown as Sessions
    const remote = owner.get(REMOTE_SERVICE) as RemotePort
    const lifetime = new AbortController()
    const selections = new WeakMap<SelectOption, { sessionId: string; select(): Promise<void> }>()
    const available = (session: ClientSession): boolean => {
      if (sessions.subagentAddress(session.sessionId) !== undefined) return false
      const state = models.directoryFor(session.sessionId).store.getSnapshot()
      return state.current !== null && state.routable !== false
    }
    owner.effect(() => () => { lifetime.abort() })
    owner.effect(async () => {
      const unmount = await remote.$mount(TIER_CONTRIBUTION)
      if (lifetime.signal.aborted) return unmount
      try {
        // The dynamically mounted namespace needs its own declared Cordis dependency.
        const registration = owner.inject([TIER_REMOTE_SERVICE], scope => {
          const tiers = scope.get(TIER_REMOTE_SERVICE) as RemotePort['providerExtraTiers']
          const registered = new AbortController()
          scope.effect(() => () => { registered.abort() })
          scope.effect(() => {
            const unregister = command.register({
              name: COMMAND_NAME,
              label: () => ROW_LABEL,
              description: () => COMMAND_DESCRIPTION,
              available,
              ui: {
                kind: 'popupSelect',
                searchLabels: () => ({ placeholder: SEARCH_PLACEHOLDER, empty: UNAVAILABLE, noResults: NO_RESULTS }),
                async options(session, requestSignal) {
                  const opening = new AbortController()
                  const signal = AbortSignal.any([requestSignal, lifetime.signal, registered.signal, opening.signal])
                  signal.throwIfAborted()
                  if (!available(session)) return []
                  const directory = models.directoryFor(session.sessionId)
                  const current = directory.store.getSnapshot().current!
                  const provider = parseTierIdentity(current.provider)
                  const model = parseTierIdentity(current.model)
                  const invalidate = () => {
                    const latest = directory.store.getSnapshot().current
                    try {
                      if (available(session) && models.directoryFor(session.sessionId) === directory
                        && latest?.provider === provider && latest.model === model) return
                    } catch { /* A removed session scope must not retain permission to write. */ }
                    opening.abort(new Error(STALE_ROUTE))
                  }
                  const checkRoute = () => { invalidate(); signal.throwIfAborted() }
                  // A route that changes away and back still invalidates the original billing decision.
                  const unsubscribe = directory.store.subscribe(invalidate)
                  signal.addEventListener('abort', unsubscribe, { once: true })
                  let view: TierView
                  try {
                    await directory.load()
                    checkRoute()
                    view = parseTierView(resultValue(await tiers.describe(provider, model, signal), READ_ERROR))
                    checkRoute()
                  } catch {
                    const error: unknown = signal.aborted ? signal.reason : new Error(READ_ERROR)
                    opening.abort()
                    throw error
                  }
                  if (view.choices.length === 0) { opening.abort(); return [] }
                  const options: SelectOption[] = [
                    { id: TIER_DEFAULT, label: DEFAULT_LABEL, active: view.current === undefined },
                    ...view.choices.map(choice => ({ id: choice.id, label: choice.name, detail: choice.description, active: view.current === choice.id })),
                  ]
                  for (const option of options) {
                    const tier = option.id === TIER_DEFAULT ? undefined : option.id
                    selections.set(option, {
                      sessionId: session.sessionId,
                      async select() {
                        checkRoute()
                        try {
                          parseVoid(resultValue(await tiers.select(provider, model, tier, signal), TIER_SAVE_ERROR))
                        } catch {
                          signal.throwIfAborted()
                          throw new Error(TIER_SAVE_ERROR)
                        }
                        checkRoute()
                        // The stock shell does not abort its signal on successful selection.
                        opening.abort()
                      },
                    })
                  }
                  return options
                },
                async onSelect(option, session) {
                  const selection = selections.get(option)
                  if (selection === undefined || selection.sessionId !== session.sessionId) throw new Error(INVALID_CHOICE)
                  await selection.select()
                },
              },
            })
            return () => { command.dismiss(COMMAND_NAME); unregister() }
          })
        })
        await registration
        return async () => { await registration.dispose(); await unmount() }
      } catch (error) {
        await unmount()
        throw error
      }
    })
  })
}
