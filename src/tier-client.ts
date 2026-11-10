/** One dependency-free runtime keeps Host and browser boundary validation identical. */
import type { Context } from '@deepseek-ai/cordis'
import type * as ReactNamespace from 'react'

export const TIER_PACKAGE = '@sagmans/dsh-provider-extra'
export const TIER_NAMESPACE = 'providerExtraTiers'
export const TIER_DEFAULT = ''
const COMMAND_NAME = 'service-tier'
export const TIER_SAVE_ERROR =
  'Could not confirm service tier; check writable shared storage, then reopen /service-tier before retrying'
const READ_ERROR = 'Could not load service tiers; reopen /service-tier to retry'
const INVALID_WIRE = 'Invalid service tier data'
const INVALID_CHOICE = 'Invalid service tier selection'
const ROW_LABEL = 'Service tier'
const DEFAULT_LABEL = 'Provider default'
const COMMAND_SERVICE = 'commandUi'
const MODEL_SERVICE = 'modelDirectories'
const SESSION_SERVICE = 'sessions'
const REMOTE_SERVICE = 'remote'
const TIER_REMOTE_SERVICE = `${REMOTE_SERVICE}.${TIER_NAMESPACE}`
const UNAVAILABLE = 'Service tiers are unavailable for this model or session'
const STALE_ROUTE = 'Model changed; reopen /service-tier before saving'
const COMMAND_DESCRIPTION = 'Choose the current model’s shared service tier'
const SEARCH_PLACEHOLDER = 'Search service tiers'
const NO_RESULTS = 'No matching service tiers'
const TIER_IDS = ['auto', 'default', 'priority'] as const

/** Sign-in transport lives beside the tier namespace; both are Web-only surfaces. */
export const AUTH_NAMESPACE = 'providerExtraAuth'
/** Its own contribution identity: the tier face already claims the package's `host` face. */
export const AUTH_PACKAGE = `${TIER_PACKAGE}/sign-in`
const AUTH_REMOTE_SERVICE = `${REMOTE_SERVICE}.${AUTH_NAMESPACE}`
/** The Models page keys provider cards by the adapter family's settings namespace. */
const PI_AI_SETTINGS_NS = 'llm-pi-ai'
/** Routes whose OAuth flow this surface offers today; add an id after proving its flow. */
const SIGN_IN_PROVIDERS: readonly string[] = ['openai-codex']
/** A restart begins a fresh attempt list; attempts stay addressable while this page polls it. */
const AUTH_POLL_MS = 400
const AUTH_INVALID = 'Invalid sign-in data'
const AUTH_LIST_ERROR = 'Could not read sign-in state'
const AUTH_START_ERROR = 'Could not start sign-in'
const AUTH_POLL_ERROR = 'Sign-in stopped responding; close this panel and try again'
const AUTH_ANSWER_ERROR = 'Could not deliver that answer'
const AUTH_COPY_FAILED = 'Copy failed'
const AUTH_ANSWER_MAX = 8_192

/** Wire choices preserve the provider owner's capability decision. */
export interface TierChoice {
  id: string
  name: string
  description: string
}
/** Omitted current means provider policy, not an explicit Standard override. */
export interface TierView {
  choices: readonly TierChoice[]
  current?: string
}
/** Structural subsets mirror npm's public contracts without runtime or React imports. */
interface ClientSession {
  readonly sessionId: string
}
interface SelectOption {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly active?: boolean
}
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
interface ModelState {
  current: { provider: string; model: string } | null
  routable: boolean | null
}
interface ModelDirectories {
  directoryFor(sessionId: string): {
    load(): Promise<ModelState>
    store: { getSnapshot(): ModelState; subscribe(listener: () => void): () => void }
  }
}
interface Sessions {
  subagentAddress(sessionId: string): unknown
}
interface RemotePort {
  $mount(contribution: unknown): Promise<() => Promise<void>>
  providerExtraTiers: {
    describe(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
    select(
      provider: string,
      model: string,
      tier: string | undefined,
      signal?: AbortSignal,
    ): Promise<unknown>
  }
}

/** Reject extra fields instead of forwarding accidental provider state. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw new TypeError(INVALID_WIRE)
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
  if (typeof value !== 'string' || !TIER_IDS.some((id) => id === value))
    throw new TypeError(INVALID_WIRE)
  return value
}
/** Both gateway output and browser input require a complete, consistent view. */
export function parseTierView(value: unknown): TierView {
  const input = record(value, ['choices', 'current'])
  if (!Array.isArray(input.choices)) throw new TypeError(INVALID_WIRE)
  const choices = input.choices.map((value) => {
    const choice = record(value, ['id', 'name', 'description'])
    const id = parseTier(choice.id)
    if (id === undefined) throw new TypeError(INVALID_WIRE)
    return {
      id,
      name: parseTierIdentity(choice.name),
      description: parseTierIdentity(choice.description),
    }
  })
  const ids = new Set(choices.map((choice) => choice.id))
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
const IDENTITY_CODEC = strict(`${TIER_PACKAGE}.TierIdentity`, parseTierIdentity)
const TIER_CODEC = strict(`${TIER_PACKAGE}.TierSelection`, parseTier)
const VIEW_CODEC = strict(`${TIER_PACKAGE}.TierView`, parseTierView)
const VOID_CODEC = strict('void', parseVoid)
const ROUTE_PARAMETERS = [
  { name: 'provider', wire: 'provider', source: 'json', codec: IDENTITY_CODEC },
  { name: 'model', wire: 'model', source: 'json', codec: IDENTITY_CODEC },
] as const
/** Explicit descriptors avoid a generator or a multi-module browser bundler. */
export const TIER_CONTRIBUTION = {
  package: TIER_PACKAGE,
  descriptors: [
    {
      id: `${TIER_NAMESPACE}/describe`,
      service: TIER_NAMESPACE,
      namespace: TIER_NAMESPACE,
      method: 'describe',
      invocation: { kind: 'direct' },
      parameters: ROUTE_PARAMETERS,
      cancellation: { parameter: 'signal' },
      result: VIEW_CODEC,
    },
    {
      id: `${TIER_NAMESPACE}/select`,
      service: TIER_NAMESPACE,
      namespace: TIER_NAMESPACE,
      method: 'select',
      invocation: { kind: 'direct' },
      parameters: [
        ...ROUTE_PARAMETERS,
        { name: 'tier', wire: 'tier', source: 'json', acceptsUndefined: true, codec: TIER_CODEC },
      ],
      cancellation: { parameter: 'signal' },
      result: VOID_CODEC,
    },
  ],
} as const

/** One registered flow a provider card can drive; `provider` is the record's id. */
export interface AuthEntry {
  key: string
  provider: string
  label: string
  stored: boolean
  inFlight: boolean
}

/** Instructions one attempt wants the human to see; no secret crosses here. */
export interface AuthNotice {
  message: string
  url?: string
  code?: string
}

/** One selectable answer a flow offers. */
export interface AuthPromptOption {
  id: string
  label: string
  description?: string
}

/** A question the flow is waiting on; `select` answers with an option id. */
export interface AuthPrompt {
  promptId: string
  kind: 'text' | 'secret' | 'select'
  message: string
  placeholder?: string
  options?: readonly AuthPromptOption[]
}

/** One frame of one attempt, replayed in order from the first step. */
export type AuthEvent =
  | { type: 'notice'; notice: AuthNotice }
  | { type: 'prompt'; prompt: AuthPrompt }
  | { type: 'prompt-closed'; promptId: string }
  | { type: 'settled'; status: 'authorized' | 'cancelled' | 'failed'; message?: string }

/** One poll: frames after the caller's cursor, and whether the attempt ended. */
export interface AuthPoll {
  cursor: number
  events: readonly AuthEvent[]
  done: boolean
}

/** The handle returned once an attempt starts. */
export interface AuthStart {
  attemptId: string
}

/** Empty or non-text values cannot address an attempt, prompt, or flow. */
function parseAuthText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(AUTH_INVALID)
  return value
}
/** Cursors are non-negative frame counts; a fractional or negative one is a bug, not a resume point. */
function parseAuthCursor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(AUTH_INVALID)
  return value
}
/** Booleans cross as booleans; a JSON 0/1 would hide a version skew. */
function parseAuthBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError(AUTH_INVALID)
  return value
}
/** One notice, with only the fields its frame declares. */
function parseAuthNotice(value: unknown): AuthNotice {
  const input = record(value, ['message', 'url', 'code'])
  return {
    message: parseAuthText(input.message),
    ...(input.url === undefined ? {} : { url: parseAuthText(input.url) }),
    ...(input.code === undefined ? {} : { code: parseAuthText(input.code) }),
  }
}
/** One option; the description is display-only context. */
function parseAuthOption(value: unknown): AuthPromptOption {
  const input = record(value, ['id', 'label', 'description'])
  return {
    id: parseAuthText(input.id),
    label: parseAuthText(input.label),
    ...(input.description === undefined ? {} : { description: parseAuthText(input.description) }),
  }
}
/** One prompt; a select must carry choices and the others must not. */
function parseAuthPrompt(value: unknown): AuthPrompt {
  const input = record(value, ['promptId', 'kind', 'message', 'placeholder', 'options'])
  const kind = input.kind
  if (kind !== 'text' && kind !== 'secret' && kind !== 'select') throw new TypeError(AUTH_INVALID)
  const base: AuthPrompt = {
    promptId: parseAuthText(input.promptId),
    kind,
    message: parseAuthText(input.message),
    ...(input.placeholder === undefined ? {} : { placeholder: parseAuthText(input.placeholder) }),
  }
  if (kind !== 'select') {
    if (input.options !== undefined) throw new TypeError(AUTH_INVALID)
    return base
  }
  if (!Array.isArray(input.options) || input.options.length === 0) throw new TypeError(AUTH_INVALID)
  return { ...base, options: input.options.map(parseAuthOption) }
}
/** One frame; the tag decides which members must be present. */
function parseAuthEvent(value: unknown): AuthEvent {
  const tagged = value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!tagged || !('type' in value)) throw new TypeError(AUTH_INVALID)
  switch (value.type) {
    case 'notice': {
      const input = record(value, ['type', 'notice'])
      return { type: 'notice', notice: parseAuthNotice(input.notice) }
    }
    case 'prompt': {
      const input = record(value, ['type', 'prompt'])
      return { type: 'prompt', prompt: parseAuthPrompt(input.prompt) }
    }
    case 'prompt-closed': {
      const input = record(value, ['type', 'promptId'])
      return { type: 'prompt-closed', promptId: parseAuthText(input.promptId) }
    }
    case 'settled': {
      const input = record(value, ['type', 'status', 'message'])
      const status = input.status
      if (status !== 'authorized' && status !== 'cancelled' && status !== 'failed')
        throw new TypeError(AUTH_INVALID)
      return {
        type: 'settled',
        status,
        ...(input.message === undefined ? {} : { message: parseAuthText(input.message) }),
      }
    }
    default:
      throw new TypeError(AUTH_INVALID)
  }
}
/** One flow list; a duplicated key would render two controls for one credential. */
function parseAuthEntries(value: unknown): readonly AuthEntry[] {
  if (!Array.isArray(value)) throw new TypeError(AUTH_INVALID)
  const entries = value.map((item) => {
    const input = record(item, ['key', 'provider', 'label', 'stored', 'inFlight'])
    return {
      key: parseAuthText(input.key),
      provider: parseAuthText(input.provider),
      label: parseAuthText(input.label),
      stored: parseAuthBoolean(input.stored),
      inFlight: parseAuthBoolean(input.inFlight),
    }
  })
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length)
    throw new TypeError(AUTH_INVALID)
  return entries
}
/** One start result. */
function parseAuthStart(value: unknown): AuthStart {
  const input = record(value, ['attemptId'])
  return { attemptId: parseAuthText(input.attemptId) }
}
/** One poll result; `done` without the settlement frame would strand the panel. */
function parseAuthPoll(value: unknown): AuthPoll {
  const input = record(value, ['cursor', 'events', 'done'])
  if (!Array.isArray(input.events)) throw new TypeError(AUTH_INVALID)
  const events = input.events.map(parseAuthEvent)
  const done = parseAuthBoolean(input.done)
  if (done && events.at(-1)?.type !== 'settled') throw new TypeError(AUTH_INVALID)
  return { cursor: parseAuthCursor(input.cursor), events, done }
}

const AUTH_TEXT_CODEC = strict(`${AUTH_PACKAGE}.AuthText`, parseAuthText)
const AUTH_CURSOR_CODEC = strict(`${AUTH_PACKAGE}.AuthCursor`, parseAuthCursor)
const AUTH_BOOLEAN_CODEC = strict(`${AUTH_PACKAGE}.AuthBoolean`, parseAuthBoolean)
const AUTH_ENTRIES_CODEC = strict(`${AUTH_PACKAGE}.AuthEntries`, parseAuthEntries)
const AUTH_START_CODEC = strict(`${AUTH_PACKAGE}.AuthStart`, parseAuthStart)
const AUTH_POLL_CODEC = strict(`${AUTH_PACKAGE}.AuthPoll`, parseAuthPoll)

/** The attempt transport is poll-based so the Host needs no stream descriptor. */
export const AUTH_CONTRIBUTION = {
  package: AUTH_PACKAGE,
  descriptors: [
    {
      id: `${AUTH_NAMESPACE}/list`,
      service: AUTH_NAMESPACE,
      namespace: AUTH_NAMESPACE,
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [],
      result: AUTH_ENTRIES_CODEC,
    },
    {
      id: `${AUTH_NAMESPACE}/begin`,
      service: AUTH_NAMESPACE,
      namespace: AUTH_NAMESPACE,
      method: 'begin',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'key', wire: 'key', source: 'json', codec: AUTH_TEXT_CODEC }],
      result: AUTH_START_CODEC,
    },
    {
      id: `${AUTH_NAMESPACE}/poll`,
      service: AUTH_NAMESPACE,
      namespace: AUTH_NAMESPACE,
      method: 'poll',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'attemptId', wire: 'attemptId', source: 'json', codec: AUTH_TEXT_CODEC },
        { name: 'cursor', wire: 'cursor', source: 'json', codec: AUTH_CURSOR_CODEC },
      ],
      result: AUTH_POLL_CODEC,
    },
    {
      id: `${AUTH_NAMESPACE}/answer`,
      service: AUTH_NAMESPACE,
      namespace: AUTH_NAMESPACE,
      method: 'answer',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'attemptId', wire: 'attemptId', source: 'json', codec: AUTH_TEXT_CODEC },
        { name: 'promptId', wire: 'promptId', source: 'json', codec: AUTH_TEXT_CODEC },
        { name: 'value', wire: 'value', source: 'json', codec: AUTH_TEXT_CODEC },
      ],
      result: AUTH_BOOLEAN_CODEC,
    },
    {
      id: `${AUTH_NAMESPACE}/decline`,
      service: AUTH_NAMESPACE,
      namespace: AUTH_NAMESPACE,
      method: 'decline',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'attemptId', wire: 'attemptId', source: 'json', codec: AUTH_TEXT_CODEC },
        { name: 'promptId', wire: 'promptId', source: 'json', codec: AUTH_TEXT_CODEC },
      ],
      result: AUTH_BOOLEAN_CODEC,
    },
    {
      id: `${AUTH_NAMESPACE}/cancel`,
      service: AUTH_NAMESPACE,
      namespace: AUTH_NAMESPACE,
      method: 'cancel',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'attemptId', wire: 'attemptId', source: 'json', codec: AUTH_TEXT_CODEC },
      ],
      result: VOID_CODEC,
    },
  ],
} as const

/** Remote failures contain transport detail that must not become UI error text. */
function resultValue(result: unknown, message: string): unknown {
  if (result === null || typeof result !== 'object' || !('ok' in result) || result.ok !== true)
    throw new Error(message)
  const envelope = record(result, ['ok', 'value'])
  return envelope.value
}

/** The save a menu row runs when chosen, kept by option so a stale row cannot act on another session. */
interface TierSelection {
  readonly sessionId: string
  select(): Promise<void>
}

/** What one opening of the menu reads, and the lifetimes that can cancel it. */
interface TierMenu {
  readonly models: ModelDirectories
  readonly tiers: RemotePort['providerExtraTiers']
  readonly selections: WeakMap<SelectOption, TierSelection>
  readonly available: (session: ClientSession) => boolean
  readonly lifetime: AbortSignal
  readonly registered: AbortSignal
}

/** Open the menu for the session's current route; any route change after this cancels its rows. */
async function openTierMenu(
  menu: TierMenu,
  session: ClientSession,
  requestSignal: AbortSignal,
): Promise<SelectOption[]> {
  const opening = new AbortController()
  const signal = AbortSignal.any([requestSignal, menu.lifetime, menu.registered, opening.signal])
  signal.throwIfAborted()
  if (!menu.available(session)) return []
  const directory = menu.models.directoryFor(session.sessionId)
  const current = directory.store.getSnapshot().current
  // The menu has nothing to offer until the session has chosen a model.
  if (!current) return []
  const provider = parseTierIdentity(current.provider)
  const model = parseTierIdentity(current.model)
  const invalidate = () => {
    const latest = directory.store.getSnapshot().current
    try {
      if (
        menu.available(session) &&
        menu.models.directoryFor(session.sessionId) === directory &&
        latest?.provider === provider &&
        latest.model === model
      )
        return
    } catch {
      /* A removed session scope must not retain permission to write. */
    }
    opening.abort(new Error(STALE_ROUTE))
  }
  const checkRoute = () => {
    invalidate()
    signal.throwIfAborted()
  }
  // A route that changes away and back still invalidates the original billing decision.
  const unsubscribe = directory.store.subscribe(invalidate)
  signal.addEventListener('abort', unsubscribe, { once: true })
  let view: TierView
  try {
    await directory.load()
    checkRoute()
    view = parseTierView(
      resultValue(await menu.tiers.describe(provider, model, signal), READ_ERROR),
    )
    checkRoute()
  } catch {
    const error: unknown = signal.aborted ? signal.reason : new Error(READ_ERROR)
    opening.abort()
    throw error
  }
  if (view.choices.length === 0) {
    opening.abort()
    return []
  }
  const options: SelectOption[] = [
    { id: TIER_DEFAULT, label: DEFAULT_LABEL, active: view.current === undefined },
    ...view.choices.map((choice) => ({
      id: choice.id,
      label: choice.name,
      detail: choice.description,
      active: view.current === choice.id,
    })),
  ]
  for (const option of options) {
    const tier = option.id === TIER_DEFAULT ? undefined : option.id
    menu.selections.set(option, {
      sessionId: session.sessionId,
      async select() {
        checkRoute()
        try {
          parseVoid(
            resultValue(await menu.tiers.select(provider, model, tier, signal), TIER_SAVE_ERROR),
          )
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
}

/** Optional injection keeps older hosts inert and scopes command ownership to HMR lifetime. */

/** The browser loader hands `require` to this factory; the Host imports the
 * same module only for its wire contract and never runs the client half. */
declare const require: (id: string) => unknown

/** Resolve React only when the browser half runs; the Host bundle has no React. */
function reactRuntime(): typeof ReactNamespace {
  return require('react') as typeof ReactNamespace
}

/** One page's view of the Remote namespace; results stay unvalidated until a parser sees them. */
interface AuthRemotePort {
  list(): Promise<unknown>
  begin(key: string): Promise<unknown>
  poll(attemptId: string, cursor: number): Promise<unknown>
  answer(attemptId: string, promptId: string, value: string): Promise<unknown>
  decline(attemptId: string, promptId: string): Promise<unknown>
  cancel(attemptId: string): Promise<unknown>
}

/** The Slot service face this registration uses; the interaction surface owns the rest. */
interface SlotsPort {
  inject(name: string, factory: () => () => void): void
  register(options: { name: string; key?: string }, component: unknown): () => void
}

/** Owner share of one Models provider-card extension occurrence. */
interface ProviderCardShare {
  provider: {
    provider: string
    nativeAuth?: { oauth?: boolean; env?: readonly string[] }
  }
}

/** Only a keyless OAuth route gets a sign-in control; a key field already covers the rest. */
function signInEligible(props: ProviderCardShare): boolean {
  const entry = props.provider
  return (
    entry !== undefined &&
    SIGN_IN_PROVIDERS.includes(entry.provider) &&
    entry.nativeAuth?.oauth === true &&
    (entry.nativeAuth.env?.length ?? 0) === 0
  )
}

/** Keep transport detail out of the panel while still naming what failed. */
function authFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return AUTH_POLL_ERROR
}

const AUTH_STYLES = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  button: {
    alignSelf: 'flex-start',
    border: '1px solid var(--dsh-border, #555)',
    borderRadius: '6px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
    padding: '4px 12px',
  },
  primary: {
    alignSelf: 'flex-start',
    border: '1px solid transparent',
    borderRadius: '6px',
    background: 'var(--dsh-accent, #3b82f6)',
    color: 'var(--dsh-accent-foreground, #ffffff)',
    cursor: 'pointer',
    font: 'inherit',
    padding: '4px 12px',
  },
  hint: { opacity: 0.7, fontSize: '0.9em' },
  notice: { margin: 0 },
  error: { color: '#e5484d', margin: 0 },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  input: {
    border: '1px solid currentColor',
    borderRadius: '6px',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    padding: '4px 8px',
    width: '100%',
  },
  link: { color: 'inherit', textDecoration: 'underline', cursor: 'pointer' },
} satisfies Record<string, ReactNamespace.CSSProperties>

/** Clipboard access can fail without permission; the label reports which happened. */
async function copyToClipboard(value: string): Promise<'copied' | 'failed'> {
  try {
    await navigator.clipboard.writeText(value)
    return 'copied'
  } catch {
    return 'failed'
  }
}

/** Read and validate the flow list; an unavailable Host reads as no flows. */
async function readAuthEntries(auth: AuthRemotePort): Promise<readonly AuthEntry[]> {
  return parseAuthEntries(resultValue(await auth.list(), AUTH_LIST_ERROR))
}

/** Start one attempt and return the handle its poller uses. */
async function beginAttempt(auth: AuthRemotePort, key: string): Promise<string> {
  return parseAuthStart(resultValue(await auth.begin(key), AUTH_START_ERROR)).attemptId
}

/** Who to ask, and whether the panel that asked is still open. */
interface PollTarget {
  readonly auth: AuthRemotePort
  readonly attemptId: string
  readonly apply: (event: AuthEvent) => void
  readonly live: () => boolean
}

/** Poll one attempt until it settles or the panel closes. */
async function pollAttempt(target: PollTarget): Promise<void> {
  let cursor = 0
  while (target.live()) {
    const poll = parseAuthPoll(
      resultValue(await target.auth.poll(target.attemptId, cursor), AUTH_POLL_ERROR),
    )
    cursor = poll.cursor
    for (const event of poll.events) target.apply(event)
    if (poll.done) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, AUTH_POLL_MS)
    })
  }
}

/** Props of {@link SignInNotice}. */
interface SignInNoticeProps {
  notice: AuthNotice
  copy: 'copied' | 'failed' | undefined
  onCopy: (value: string) => void
}

/** One notice, with only the actions its own fields warrant. */
function SignInNotice(props: SignInNoticeProps): ReactNamespace.ReactNode {
  const { createElement: h } = reactRuntime()
  const { notice } = props
  return h('div', { style: AUTH_STYLES.field }, [
    h('p', { key: 'message', style: AUTH_STYLES.notice }, notice.message),
    notice.url === undefined
      ? null
      : h('div', { key: 'url', style: AUTH_STYLES.row }, [
          h(
            'a',
            {
              key: 'open',
              href: notice.url,
              target: '_blank',
              rel: 'noreferrer noopener',
              style: AUTH_STYLES.link,
            },
            'Open sign-in page',
          ),
          h(
            'button',
            {
              key: 'copy',
              type: 'button',
              style: AUTH_STYLES.button,
              onClick: () => {
                props.onCopy(notice.url ?? '')
              },
            },
            props.copy === 'copied'
              ? 'Copied'
              : props.copy === 'failed'
                ? AUTH_COPY_FAILED
                : 'Copy link',
          ),
        ]),
    notice.code === undefined
      ? null
      : h('p', { key: 'code', style: AUTH_STYLES.notice }, `Verification code: ${notice.code}`),
  ])
}

/** Props of {@link SignInPrompt}. */
interface SignInPromptProps {
  prompt: AuthPrompt
  answer: string
  busy: boolean
  onAnswer: (value: string) => void
  onSubmit: (value: string) => void
  onDecline: () => void
}

/** One question: choices are buttons, typed answers are an input. */
function SignInPrompt(props: SignInPromptProps): ReactNamespace.ReactNode {
  const { createElement: h } = reactRuntime()
  const { prompt, busy } = props
  const choices =
    prompt.kind === 'select'
      ? h(
          'div',
          { key: 'options', style: AUTH_STYLES.row },
          (prompt.options ?? []).map((option) =>
            h(
              'button',
              {
                key: option.id,
                type: 'button',
                disabled: busy,
                style: AUTH_STYLES.button,
                onClick: () => {
                  props.onSubmit(option.id)
                },
              },
              option.label,
            ),
          ),
        )
      : h('div', { key: 'typed', style: AUTH_STYLES.field }, [
          h('input', {
            key: 'input',
            type: prompt.kind === 'secret' ? 'password' : 'text',
            value: props.answer,
            maxLength: AUTH_ANSWER_MAX,
            placeholder: prompt.placeholder ?? '',
            'aria-label': prompt.message,
            disabled: busy,
            style: AUTH_STYLES.input,
            onChange: (event: { target: { value: string } }) => {
              props.onAnswer(event.target.value)
            },
            onKeyDown: (event: { key: string }) => {
              if (event.key === 'Enter') props.onSubmit(props.answer)
            },
          }),
          h('div', { key: 'actions', style: AUTH_STYLES.row }, [
            h(
              'button',
              {
                key: 'continue',
                type: 'button',
                disabled: busy || props.answer.trim() === '',
                style: AUTH_STYLES.primary,
                onClick: () => {
                  props.onSubmit(props.answer)
                },
              },
              'Continue',
            ),
            h(
              'button',
              {
                key: 'decline',
                type: 'button',
                disabled: busy,
                style: AUTH_STYLES.button,
                onClick: props.onDecline,
              },
              'Decline',
            ),
          ]),
        ])
  return h('div', { style: AUTH_STYLES.field }, [
    h('p', { key: 'message', style: AUTH_STYLES.notice }, prompt.message),
    choices,
  ])
}

/** Props of {@link SignInPanel}. */
interface SignInPanelProps {
  notice?: AuthNotice
  prompt?: AuthPrompt
  status?: 'running' | 'authorized' | 'cancelled' | 'failed'
  failure?: string
  answer: string
  busy: boolean
  copy: 'copied' | 'failed' | undefined
  onAnswer: (value: string) => void
  onSubmit: (value: string) => void
  onDecline: () => void
  onCopy: (value: string) => void
  onClose: () => void
}

/** The opened panel: instructions, the current question, and the exit. */
function SignInPanel(props: SignInPanelProps): ReactNamespace.ReactNode {
  const { createElement: h } = reactRuntime()
  const running = props.status === 'running'
  const outcome =
    props.status === 'authorized'
      ? h('p', { key: 'ok', style: AUTH_STYLES.notice }, 'Signed in. No API key was stored.')
      : props.status === 'cancelled'
        ? h('p', { key: 'cancelled', style: AUTH_STYLES.notice }, 'Sign-in was cancelled.')
        : null
  return h('div', { style: AUTH_STYLES.field }, [
    props.failure === undefined
      ? null
      : h('p', { key: 'failure', style: AUTH_STYLES.error }, props.failure),
    props.notice === undefined
      ? null
      : h(SignInNotice, {
          key: 'notice',
          notice: props.notice,
          copy: props.copy,
          onCopy: props.onCopy,
        }),
    props.prompt === undefined
      ? null
      : h(SignInPrompt, {
          key: 'prompt',
          prompt: props.prompt,
          answer: props.answer,
          busy: props.busy,
          onAnswer: props.onAnswer,
          onSubmit: props.onSubmit,
          onDecline: props.onDecline,
        }),
    running
      ? h('p', { key: 'waiting', style: AUTH_STYLES.hint }, 'Waiting for the provider…')
      : null,
    outcome,
    h(
      'button',
      { key: 'close', type: 'button', style: AUTH_STYLES.button, onClick: props.onClose },
      running ? 'Cancel' : 'Close',
    ),
  ])
}

/** One frame sink for a poller. */
type AuthEventSink = (event: AuthEvent) => void

/** One failure sink for a poller. */
type FailureSink = (message: string) => void

/** Poll one attempt for as long as the panel is open, reporting failures as a settlement. */
function useAttemptPolling(
  auth: AuthRemotePort,
  attemptId: string | undefined,
  apply: AuthEventSink,
  onFailure: FailureSink,
): void {
  const { useEffect, useRef } = reactRuntime()
  // The callbacks are fresh each render; only the attempt identity may restart
  // the poller, or every frame would replay from cursor zero.
  const sink = useRef(apply)
  sink.current = apply
  const fail = useRef(onFailure)
  fail.current = onFailure
  useEffect(() => {
    if (attemptId === undefined) return
    let polling = true
    void pollAttempt({
      auth,
      attemptId,
      apply: (event) => {
        sink.current(event)
      },
      live: () => polling,
    }).catch((error: unknown) => {
      if (polling) fail.current(authFailure(error))
    })
    return () => {
      polling = false
    }
  }, [attemptId, auth])
}

/** Deliver one typed answer; the refusal message is ready for the panel. */
async function submitAnswer(
  auth: AuthRemotePort,
  attemptId: string,
  prompt: AuthPrompt,
  value: string,
): Promise<string | undefined> {
  const accepted = parseAuthBoolean(
    resultValue(await auth.answer(attemptId, prompt.promptId, value), AUTH_ANSWER_ERROR),
  )
  return accepted ? undefined : AUTH_ANSWER_ERROR
}

/** Refuse one question; a transport failure is reported to the caller. */
async function declineQuestion(
  auth: AuthRemotePort,
  attemptId: string,
  prompt: AuthPrompt,
): Promise<void> {
  await auth.decline(attemptId, prompt.promptId)
}

/** Owner share plus this card's bound Remote namespace. */
interface ProviderSignInCardProps extends ProviderCardShare {
  auth: AuthRemotePort
}

/** Everything the view needs, bound to the callbacks the card owns. */
interface ProviderSignInViewProps {
  entry?: AuthEntry
  open: boolean
  status?: 'running' | 'authorized' | 'cancelled' | 'failed'
  notice?: AuthNotice
  prompt?: AuthPrompt
  failure?: string
  answer: string
  busy: boolean
  copy: 'copied' | 'failed' | undefined
  onStart: () => void
  onAnswer: (value: string) => void
  onSubmit: (value: string) => void
  onDecline: () => void
  onCopy: (value: string) => void
  onClose: () => void
}

/** The card: a stored-grant summary and the panel an open attempt shows. */
function ProviderSignInView(props: ProviderSignInViewProps): ReactNamespace.ReactNode {
  const { createElement: h } = reactRuntime()
  const stored = props.entry?.stored === true
  const state =
    props.entry === undefined
      ? (props.failure ?? 'No sign-in flow is registered for this provider')
      : stored
        ? 'Signed in'
        : 'Sign in with the provider account'
  return h('div', { style: AUTH_STYLES.wrap }, [
    h('div', { key: 'head', style: AUTH_STYLES.row }, [
      h(
        'button',
        {
          key: 'button',
          type: 'button',
          disabled: props.entry === undefined || props.busy || props.status === 'running',
          onClick: props.onStart,
          style: stored ? AUTH_STYLES.button : AUTH_STYLES.primary,
        },
        props.entry === undefined ? 'Sign-in unavailable' : stored ? 'Sign in again' : 'Sign in',
      ),
      h('span', { key: 'state', style: AUTH_STYLES.hint }, state),
    ]),
    props.open
      ? h(SignInPanel, {
          key: 'panel',
          notice: props.notice,
          prompt: props.prompt,
          status: props.status,
          failure: props.failure,
          answer: props.answer,
          busy: props.busy,
          copy: props.copy,
          onAnswer: props.onAnswer,
          onSubmit: props.onSubmit,
          onDecline: props.onDecline,
          onCopy: props.onCopy,
          onClose: props.onClose,
        })
      : null,
  ])
}

/** Load the flow list once per provider and report a failed read. */
function useFlowEntries(
  auth: AuthRemotePort,
  reload: number,
  onFailure: FailureSink,
): readonly AuthEntry[] | undefined {
  const { useEffect, useRef, useState } = reactRuntime()
  const [entries, setEntries] = useState<readonly AuthEntry[] | undefined>(undefined)
  const fail = useRef(onFailure)
  fail.current = onFailure
  useEffect(() => {
    let current = true
    void readAuthEntries(auth).then(
      (list) => {
        if (current) setEntries(list)
      },
      (error: unknown) => {
        if (!current) return
        setEntries([])
        fail.current(authFailure(error))
      },
    )
    return () => {
      current = false
    }
  }, [auth, reload])
  return entries
}

/** Copy feedback, reset after the label has been read. */
function useCopyFeedback(): {
  copy: 'copied' | 'failed' | undefined
  copyValue: (value: string) => void
} {
  const { useEffect, useState } = reactRuntime()
  const [copy, setCopy] = useState<'copied' | 'failed' | undefined>(undefined)
  useEffect(() => {
    if (copy === undefined) return
    const timer = setTimeout(() => {
      setCopy(undefined)
    }, 2000)
    return () => {
      clearTimeout(timer)
    }
  }, [copy])
  return {
    copy,
    copyValue: (value: string) => {
      void copyToClipboard(value).then(setCopy)
    },
  }
}

/** Withdraw whatever attempt is still running when the card unmounts. */
function useCancelOnUnmount(auth: AuthRemotePort, running: string | undefined): void {
  const { useEffect, useRef } = reactRuntime()
  const live = useRef<string | undefined>(undefined)
  live.current = running
  useEffect(() => {
    return () => {
      const attempt = live.current
      if (attempt !== undefined) void auth.cancel(attempt)
    }
  }, [auth])
}

/** The attempt UI one card owns; one panel at a time. */
interface FlowUi {
  open: boolean
  attemptId?: string
  status?: 'running' | 'authorized' | 'cancelled' | 'failed'
  notice?: AuthNotice
  prompt?: AuthPrompt
  answer: string
  failure?: string
  busy: boolean
}

const EMPTY_FLOW: FlowUi = { open: false, answer: '', busy: false }

/** Every transition the panel can make. */
type FlowAction =
  | { type: 'open' }
  | { type: 'busy'; busy: boolean }
  | { type: 'started'; attemptId: string }
  | { type: 'failed'; message: string }
  | { type: 'notice'; notice: AuthNotice }
  | { type: 'prompt'; prompt: AuthPrompt }
  | { type: 'prompt-closed'; promptId: string }
  | { type: 'answer'; value: string }
  | { type: 'settled'; status: 'authorized' | 'cancelled' | 'failed'; message?: string }
  | { type: 'close' }

/** Keep one attempt's visible state in one place, so no handler clears it halfway. */
function reduceFlow(state: FlowUi, action: FlowAction): FlowUi {
  switch (action.type) {
    case 'open':
      return {
        ...EMPTY_FLOW,
        open: true,
        busy: true,
        status: 'running',
      }
    case 'busy':
      return { ...state, busy: action.busy }
    case 'started':
      return { ...state, busy: false, attemptId: action.attemptId }
    case 'failed':
      return { ...state, busy: false, status: 'failed', failure: action.message }
    case 'notice':
      return { ...state, notice: action.notice }
    case 'prompt':
      return { ...state, prompt: action.prompt, answer: '' }
    case 'prompt-closed':
      return state.prompt?.promptId === action.promptId ? { ...state, prompt: undefined } : state
    case 'answer':
      return { ...state, answer: action.value }
    case 'settled':
      return {
        ...state,
        prompt: undefined,
        status: action.status,
        ...(action.status === 'failed' ? { failure: action.message ?? 'Sign-in failed.' } : {}),
      }
    case 'close':
      return EMPTY_FLOW
  }
}

/** Map one polled frame onto its transition. */
function flowAction(event: AuthEvent): FlowAction {
  if (event.type === 'notice') return { type: 'notice', notice: event.notice }
  if (event.type === 'prompt') return { type: 'prompt', prompt: event.prompt }
  if (event.type === 'prompt-closed') return { type: 'prompt-closed', promptId: event.promptId }
  return {
    type: 'settled',
    status: event.status,
    ...(event.message === undefined ? {} : { message: event.message }),
  }
}

/** The clickable face of one provider's stored grant and running attempt. */
function ProviderSignInCard(props: ProviderSignInCardProps): ReactNamespace.ReactNode {
  const { createElement: h, useReducer, useState } = reactRuntime()
  const [ui, dispatch] = useReducer(reduceFlow, EMPTY_FLOW)
  const [reload, setReload] = useState(0)
  const fail = (message: string): void => {
    dispatch({ type: 'failed', message })
  }
  const entries = useFlowEntries(props.auth, reload, fail)
  const entry = entries?.find((candidate) => candidate.provider === props.provider.provider)
  const { copy, copyValue } = useCopyFeedback()
  useCancelOnUnmount(props.auth, ui.status === 'running' ? ui.attemptId : undefined)

  const apply = (event: AuthEvent): void => {
    dispatch(flowAction(event))
    if (event.type === 'settled' && event.status === 'authorized') setReload((value) => value + 1)
  }
  useAttemptPolling(props.auth, ui.attemptId, apply, (message) => {
    dispatch({ type: 'failed', message })
  })

  const start = async (): Promise<void> => {
    if (entry === undefined || ui.busy) return
    dispatch({ type: 'open' })
    try {
      dispatch({ type: 'started', attemptId: await beginAttempt(props.auth, entry.key) })
    } catch (error) {
      dispatch({ type: 'failed', message: authFailure(error) })
    }
  }

  const close = (): void => {
    if (ui.status === 'running' && ui.attemptId !== undefined) void props.auth.cancel(ui.attemptId)
    dispatch({ type: 'close' })
  }

  const submit = async (value: string): Promise<void> => {
    const { prompt, attemptId } = ui
    if (prompt === undefined || attemptId === undefined || ui.busy || value.trim() === '') return
    dispatch({ type: 'busy', busy: true })
    try {
      const refusal = await submitAnswer(props.auth, attemptId, prompt, value)
      if (refusal === undefined) {
        dispatch({ type: 'answer', value: '' })
        dispatch({ type: 'prompt-closed', promptId: prompt.promptId })
      } else dispatch({ type: 'failed', message: refusal })
    } catch (error) {
      dispatch({ type: 'failed', message: authFailure(error) })
    }
  }

  const decline = async (): Promise<void> => {
    const { prompt, attemptId } = ui
    if (prompt === undefined || attemptId === undefined || ui.busy) return
    dispatch({ type: 'busy', busy: true })
    try {
      await declineQuestion(props.auth, attemptId, prompt)
      dispatch({ type: 'prompt-closed', promptId: prompt.promptId })
    } catch (error) {
      dispatch({ type: 'failed', message: authFailure(error) })
    }
  }

  return h(ProviderSignInView, {
    entry,
    open: ui.open,
    status: ui.status,
    notice: ui.notice,
    prompt: ui.prompt,
    failure: ui.failure,
    answer: ui.answer,
    busy: ui.busy,
    copy,
    onStart: () => {
      void start()
    },
    onAnswer: (value: string) => {
      dispatch({ type: 'answer', value })
    },
    onSubmit: (value: string) => {
      void submit(value)
    },
    onDecline: () => {
      void decline()
    },
    onCopy: copyValue,
    onClose: close,
  })
}

/** Bind the card to one page's Remote namespace; eligibility runs before any hook. */
function createProviderSignIn(
  auth: AuthRemotePort,
): (props: ProviderCardShare) => ReactNamespace.ReactNode {
  return (props) =>
    signInEligible(props)
      ? reactRuntime().createElement(ProviderSignInCard, { ...props, auth })
      : null
}

/** Mount the attempt namespace and register the Models card extension. */
function applyProviderSignIn(ctx: Context): void {
  ctx.inject([REMOTE_SERVICE], (owner) => {
    const remote = owner.get(REMOTE_SERVICE) as RemotePort
    owner.effect(async () => {
      const unmount = await remote.$mount(AUTH_CONTRIBUTION)
      owner.inject(['slots', AUTH_REMOTE_SERVICE], (scope) => {
        const slots = scope.get('slots') as SlotsPort
        const auth = scope.get(AUTH_REMOTE_SERVICE) as AuthRemotePort
        slots.inject('settings.models.provider-card', () =>
          slots.register(
            { name: 'settings.models.provider-card', key: PI_AI_SETTINGS_NS },
            createProviderSignIn(auth),
          ),
        )
      })
      return unmount
    })
  })
}

export function apply(ctx: Context): void {
  ctx.inject([COMMAND_SERVICE, MODEL_SERVICE, SESSION_SERVICE, REMOTE_SERVICE], (owner) => {
    const command = owner.get(COMMAND_SERVICE) as CommandUi
    const models = owner.get(MODEL_SERVICE) as ModelDirectories
    const sessions = owner.get(SESSION_SERVICE) as unknown as Sessions
    const remote = owner.get(REMOTE_SERVICE) as RemotePort
    const lifetime = new AbortController()
    const selections = new WeakMap<SelectOption, TierSelection>()
    const available = (session: ClientSession): boolean => {
      if (sessions.subagentAddress(session.sessionId) !== undefined) return false
      const state = models.directoryFor(session.sessionId).store.getSnapshot()
      return state.current !== null && state.routable !== false
    }
    owner.effect(() => () => {
      lifetime.abort()
    })
    owner.effect(async () => {
      const unmount = await remote.$mount(TIER_CONTRIBUTION)
      if (lifetime.signal.aborted) return unmount
      try {
        // The dynamically mounted namespace needs its own declared Cordis dependency.
        const registration = owner.inject([TIER_REMOTE_SERVICE], (scope) => {
          const tiers = scope.get(TIER_REMOTE_SERVICE) as RemotePort['providerExtraTiers']
          const registered = new AbortController()
          scope.effect(() => () => {
            registered.abort()
          })
          scope.effect(() => {
            const unregister = command.register({
              name: COMMAND_NAME,
              label: () => ROW_LABEL,
              description: () => COMMAND_DESCRIPTION,
              available,
              ui: {
                kind: 'popupSelect',
                searchLabels: () => ({
                  placeholder: SEARCH_PLACEHOLDER,
                  empty: UNAVAILABLE,
                  noResults: NO_RESULTS,
                }),
                options: (session, requestSignal) =>
                  openTierMenu(
                    {
                      models,
                      tiers,
                      selections,
                      available,
                      lifetime: lifetime.signal,
                      registered: registered.signal,
                    },
                    session,
                    requestSignal,
                  ),
                async onSelect(option, session) {
                  const selection = selections.get(option)
                  if (selection === undefined || selection.sessionId !== session.sessionId)
                    throw new Error(INVALID_CHOICE)
                  await selection.select()
                },
              },
            })
            return () => {
              command.dismiss(COMMAND_NAME)
              unregister()
            }
          })
        })
        await registration
        return async () => {
          await registration.dispose()
          await unmount()
        }
      } catch (error) {
        await unmount()
        throw error
      }
    })
  })
  applyProviderSignIn(ctx)
}
