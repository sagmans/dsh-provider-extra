/** Tests use the npm command contribution boundary, never a model-popup extension. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test, type TestContext } from 'node:test'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { apply, TIER_CONTRIBUTION, TIER_DEFAULT, type TierView } from '../src/tier-client.ts'

const ROOT = new URL('../', import.meta.url)
const ROUTE = { provider: 'example-provider', model: 'example-alias', reasoningEffort: 'high' }
const SESSION = { sessionId: 'example-session' }
const CHOICES = [
  { id: 'auto', name: 'Auto', description: 'Account service tier' },
  { id: 'default', name: 'Standard', description: 'Standard processing' },
  { id: 'priority', name: 'Fast', description: 'Higher usage cost; subject to account access' },
]
const PRIVATE_FAILURE = '/private/example-token'
const READ_FAILURE = 'Could not load service tiers; reopen /service-tier to retry'
const SAVE_FAILURE = 'Could not confirm service tier; check writable shared storage, then reopen /service-tier before retrying'
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

/** Mirrors the published popupSelect contract; no unavailable disabled-row extension. */
interface Option { readonly id: string; readonly label: string; readonly detail?: string; readonly active?: boolean }
interface Command {
  name: string
  available(session: typeof SESSION): boolean
  ui: {
    kind: 'popupSelect'
    searchLabels(): { placeholder: string; empty: string; noResults: string }
    options(session: typeof SESSION, signal: AbortSignal): Promise<readonly Option[]>
    onSelect(option: Option, session: typeof SESSION): void | Promise<void>
  }
}

/** Only external services are faked; selections and lifecycle flow through the contribution. */
async function fixture(t: TestContext) {
  const ctx = new Context()
  const commands = new Map<string, Command>()
  const writes: unknown[][] = []
  const reads: unknown[][] = []
  const listeners = new Set<() => void>()
  const dismissed: string[] = []
  let view: TierView = { choices: CHOICES }
  let current: typeof ROUTE | null = { ...ROUTE }
  let routable: boolean | null = true
  let addressed = false
  let mounts = 0
  const remote = {
    async $mount(contribution: unknown) { assert.equal(contribution, TIER_CONTRIBUTION); mounts++; return async () => { mounts-- } },
    providerExtraTiers: {
      async describe(...args: unknown[]): Promise<unknown> { reads.push(args); return { ok: true, value: view } },
      async select(...args: unknown[]): Promise<unknown> {
        writes.push(args)
        view = { choices: CHOICES, ...(args[2] === undefined ? {} : { current: args[2] as string }) }
        return { ok: true, value: undefined }
      },
    },
  }
  const snapshot = () => ({ current, routable })
  const directory = {
    async load() { return snapshot() },
    store: { getSnapshot: snapshot, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } },
  }
  ctx.provide('remote', remote as never)
  ctx.provide('remote.providerExtraTiers', remote.providerExtraTiers as never)
  ctx.provide('sessions', { subagentAddress: () => addressed ? {} : undefined } as never)
  let resident = directory
  ctx.provide('modelDirectories', { directoryFor: () => resident } as never)
  ctx.provide('commandUi', {
    register(command: Command) { assert.equal(commands.has(command.name), false); commands.set(command.name, command); return () => { commands.delete(command.name) } },
    dismiss(name: string) { dismissed.push(name) },
  } as never)
  const fork = ctx.plugin(apply)
  await settle()
  t.after(() => fork.dispose())
  const signal = new AbortController()
  const command = () => { assert.ok(commands.has('service-tier'), 'register a stock commandUi contribution'); return commands.get('service-tier')! }
  return { ctx, remote, commands, command, writes, reads, fork, signal, directory, listeners, dismissed,
    open: () => command().ui.options(SESSION, signal.signal),
    pick: (option: Option, session = SESSION) => Promise.resolve(command().ui.onSelect(option, session)),
    setView(next: TierView) { view = next },
    setRoute(next: typeof ROUTE | null, available: boolean | null = true) { current = next; routable = available; for (const listener of [...listeners]) listener() },
    setAddressed(value: boolean) { addressed = value }, mounts: () => mounts,
    replaceSessionScope() { resident = { ...directory } },
  }
}

test('strict codecs reject malformed arguments and response fields', () => {
  const [describe, select] = TIER_CONTRIBUTION.descriptors
  for (const value of [undefined, null, '', '   ', 7, {}, []]) assert.throws(() => describe.parameters[0]!.codec.create().parse(value))
  for (const value of [null, 3, '', 'fast', {}]) assert.throws(() => select.parameters[2]!.codec.create().parse(value))
  assert.equal(select.parameters[2]!.codec.create().parse(undefined), undefined)
  for (const value of [null, [], {}, { choices: [] , secret: true }, { choices: [{ id: 'priority', name: 'Fast' }] },
    { choices: CHOICES, current: 'fast' }, { choices: [], current: 'priority' }, { choices: [...CHOICES, CHOICES[0]] }]) {
    assert.throws(() => describe.result.create().parse(value))
  }
  assert.deepEqual(describe.result.create().parse({ choices: CHOICES, current: 'priority' }), { choices: CHOICES, current: 'priority' })
  assert.throws(() => select.result.create().parse({ saved: true }))
})

test('local service-tier popup uses the current alias and preserves model and effort', async t => {
  const f = await fixture(t)
  assert.equal(f.command().ui.kind, 'popupSelect')
  assert.equal(f.command().available(SESSION), true)
  const options = await f.open()
  assert.deepEqual(options.map(row => row.label), ['Provider default', 'Auto', 'Standard', 'Fast'])
  assert.equal(options.find(row => row.active)?.id, TIER_DEFAULT)
  assert.match(options[3]!.detail!, /cost.*account/i)
  await f.pick(options[3]!)
  const reopened = await f.open()
  assert.equal(reopened.find(row => row.active)?.id, 'priority')
  await f.pick(reopened[0]!)
  assert.deepEqual(f.writes.map(args => args.slice(0, 3)), [[ROUTE.provider, ROUTE.model, 'priority'], [ROUTE.provider, ROUTE.model, undefined]])
  assert.deepEqual(f.directory.store.getSnapshot().current, ROUTE)
  assert.deepEqual([...f.commands.keys()], ['service-tier'])
})

/** Deferred transport results expose real cancellation races without sleeps. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('unsupported routes have no selectable tiers; absent and addressed routes hide the command', async t => {
  const f = await fixture(t)
  f.setView({ choices: [] })
  assert.equal(f.command().available(SESSION), true)
  assert.deepEqual(await f.open(), [])
  assert.match(f.command().ui.searchLabels().empty, /unavailable/i)
  for (const state of ['missing', 'unroutable', 'addressed'] as const) {
    f.setRoute(state === 'missing' ? null : ROUTE, state !== 'unroutable')
    f.setAddressed(state === 'addressed')
    assert.equal(f.command().available(SESSION), false)
    assert.deepEqual(await f.open(), [])
  }
  assert.equal(f.reads.length, 1)
  assert.deepEqual(f.writes, [])
})

test('session scope replacement and addressed-session changes reject previous options', async t => {
  const f = await fixture(t)
  const options = await f.open()
  f.setAddressed(true)
  await assert.rejects(f.pick(options[3]!), /Model changed/)
  f.setAddressed(false)
  const fresh = await f.open()
  f.replaceSessionScope()
  await assert.rejects(f.pick(fresh[3]!), /Model changed/)
  assert.equal(f.writes.length, 0)
})

test('a failed write retries in the same popup without changing the displayed choice', async t => {
  const f = await fixture(t)
  f.setView({ choices: CHOICES, current: 'default' })
  const options = await f.open()
  const original = f.remote.providerExtraTiers.select
  f.remote.providerExtraTiers.select = async () => { throw new Error(PRIVATE_FAILURE) }
  await assert.rejects(f.pick(options[1]!), { message: SAVE_FAILURE })
  assert.equal(options.find(row => row.active)?.id, 'default')
  f.remote.providerExtraTiers.select = original
  await f.pick(options[1]!)
  assert.equal(f.listeners.size, 0)
  assert.equal((await f.open()).find(row => row.active)?.id, 'auto')
  assert.deepEqual(f.writes.map(args => args.slice(0, 3)), [[ROUTE.provider, ROUTE.model, 'auto']])
})

test('a route changed during description cannot publish tiers even after switching back', async t => {
  const f = await fixture(t)
  const response = deferred<unknown>()
  const started = deferred<void>()
  let readSignal: AbortSignal | undefined
  f.remote.providerExtraTiers.describe = async (...args) => {
    readSignal = args[2] as AbortSignal
    started.resolve()
    return response.promise
  }
  const pending = f.open()
  await started.promise
  f.setRoute({ ...ROUTE, model: 'example-other' })
  f.setRoute(ROUTE)
  response.resolve({ ok: true, value: { choices: CHOICES } })
  await assert.rejects(pending, /Model changed/)
  assert.equal(readSignal?.aborted, true)
  assert.equal(f.listeners.size, 0)
  assert.deepEqual(f.writes, [])
})

test('selection rejects foreign options, another session, and a changed route', async t => {
  const f = await fixture(t)
  const options = await f.open()
  await assert.rejects(f.pick({ id: 'fast', label: 'Fast' }), /Invalid service tier/)
  await assert.rejects(f.pick(options[3]!, { sessionId: 'example-other-session' }), /Invalid service tier/)
  f.setRoute({ ...ROUTE, provider: 'example-other' })
  f.setRoute(ROUTE)
  await assert.rejects(f.pick(options[3]!), /Model changed/)
  assert.deepEqual(f.writes, [])
})

for (const phase of ['read', 'write'] as const) test('closing a pending ' + phase + ' aborts transport and suppresses stale settlement', async t => {
  const f = await fixture(t)
  const response = deferred<unknown>()
  const started = deferred<void>()
  let requestSignal: AbortSignal | undefined
  const delayed = async (...args: unknown[]) => {
    requestSignal = args[phase === 'read' ? 2 : 3] as AbortSignal
    started.resolve()
    return response.promise
  }
  let pending: Promise<unknown>
  if (phase === 'read') {
    f.remote.providerExtraTiers.describe = delayed
    pending = f.open()
  } else {
    const options = await f.open()
    f.remote.providerExtraTiers.select = delayed
    pending = f.pick(options[3]!)
  }
  await started.promise
  f.signal.abort()
  response.resolve({ ok: true, value: phase === 'read' ? { choices: CHOICES } : undefined })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(requestSignal?.aborted, true)
  assert.equal(f.listeners.size, 0)
})

for (const phase of ['read', 'write'] as const) for (const failure of ['reject', 'envelope', 'malformed'] as const) {
  test(phase + ' ' + failure + ' stays sanitized and recovers on reopen', async t => {
    const f = await fixture(t)
    const method = phase === 'read' ? 'describe' : 'select'
    const original = f.remote.providerExtraTiers[method]
    const options = phase === 'write' ? await f.open() : []
    f.remote.providerExtraTiers[method] = async () => {
      if (failure === 'reject') throw new Error(PRIVATE_FAILURE)
      if (failure === 'envelope') return { ok: false, error: { message: PRIVATE_FAILURE } }
      return { ok: true, value: { private: PRIVATE_FAILURE } }
    }
    await assert.rejects(phase === 'read' ? f.open() : f.pick(options[3]!), { message: phase === 'read' ? READ_FAILURE : SAVE_FAILURE })
    assert.equal(f.writes.length, 0)
    f.remote.providerExtraTiers[method] = original
    f.setView({ choices: CHOICES, current: 'default' })
    const reopened = await f.open()
    assert.equal(reopened.find(row => row.active)?.id, 'default')
    await f.pick(reopened[3]!)
    assert.deepEqual(f.writes.map(args => args.slice(0, 3)), [[ROUTE.provider, ROUTE.model, 'priority']])
  })
}

test('a save already accepted may commit, but route changes cannot report stale success', async t => {
  const f = await fixture(t)
  const options = await f.open()
  const response = deferred<void>()
  const committed: unknown[] = []
  f.remote.providerExtraTiers.select = async (...args) => {
    await response.promise
    committed.push(args[2])
    return { ok: true, value: undefined }
  }
  const pending = f.pick(options[3]!)
  f.setRoute({ ...ROUTE, model: 'example-other' })
  response.resolve()
  await assert.rejects(pending, /Model changed/)
  assert.deepEqual(committed, ['priority'])
})

for (const outcome of ['resolve', 'reject'] as const) test('HMR replacement survives an old save that will ' + outcome, async t => {
  const f = await fixture(t)
  const options = await f.open()
  const response = deferred<unknown>()
  f.remote.providerExtraTiers.select = async () => response.promise
  const pending = f.pick(options[3]!)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await f.fork.dispose()
  assert.equal(f.mounts(), 0)
  assert.equal(f.commands.size, 0)
  assert.equal(f.listeners.size, 0)
  assert.deepEqual(f.dismissed, ['service-tier'])
  const replacement = f.ctx.plugin(apply)
  t.after(() => replacement.dispose())
  await settle()
  f.remote.providerExtraTiers.select = async (...args) => { f.writes.push(args); return { ok: true, value: undefined } }
  const fresh = await f.open()
  await f.pick(fresh[2]!)
  if (outcome === 'resolve') response.resolve({ ok: true, value: undefined })
  else response.reject(new Error(PRIVATE_FAILURE))
  await rejected
  assert.equal(f.mounts(), 1)
  assert.equal(f.commands.size, 1)
  assert.deepEqual(f.writes.map(args => args.slice(0, 3)), [[ROUTE.provider, ROUTE.model, 'default']])
})

test('optional services stay inert and a late mount withdraws after disposal', async () => {
  const ctx = new Context()
  const fork = ctx.plugin(apply)
  await settle()
  const mounted = deferred<() => Promise<void>>()
  let disposed = 0
  ctx.provide('remote', { $mount: () => mounted.promise } as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('modelDirectories', {} as never)
  ctx.provide('commandUi', { register() { assert.fail('late mount must not register') } } as never)
  await settle()
  const disposing = fork.dispose()
  mounted.resolve(async () => { disposed++ })
  await disposing
  await settle()
  assert.equal(disposed, 1)
})

test('stock npm Remote facade permits popup calls from a restricted plugin context', async t => {
  const local = createRequire(import.meta.url)
  const cli = createRequire(local.resolve('@deepseek-ai/dsh/package.json'))
  const host = createRequire(cli.resolve('@deepseek-ai/dsh-web-app'))
  const cordis = await import(pathToFileURL(host.resolve('@deepseek-ai/cordis')).href)
  const { default: Registry } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-typert-registry')).href)
  let gateway: { factory(require: (id: string) => unknown): { inject: string[]; apply: (ctx: Context) => void } } | undefined
  const artifact = readFileSync(host.resolve('@deepseek-ai/dsh-api-gateway/client'), 'utf8')
  runInNewContext(artifact, { AbortController, AbortSignal, console, crypto,
    window: { __ModuleLoader__: { load(value: typeof gateway) { gateway = value } } },
  })
  const runtime = gateway!.factory(id => { assert.equal(id, '@deepseek-ai/cordis'); return cordis })
  const ctx: Context = new cordis.Context()
  const calls: { endpoint: string; args: Record<string, unknown>; signal: AbortSignal }[] = []
  let command: Command | undefined
  const directory = {
    async load() { return { current: ROUTE, routable: true } },
    store: { getSnapshot: () => ({ current: ROUTE, routable: true }), subscribe: () => () => {} },
  }
  ctx.provide('connection', {
    registerGenerationSource: () => () => {}, start: () => ({ stop() {} }),
    rpc: { open() {}, async call(_path: string, endpoint: string, payload: { args: Record<string, unknown> }, signal: AbortSignal) {
      calls.push({ endpoint, args: { ...payload.args }, signal })
      return { ok: true, value: endpoint.endsWith('/describe') ? { choices: CHOICES } : undefined }
    } },
  } as never)
  ctx.provide('commandUi', { register(value: Command) { command = value; return () => { command = undefined } }, dismiss() {} } as never)
  ctx.provide('modelDirectories', { directoryFor: () => directory } as never)
  ctx.provide('sessions', { subagentAddress: () => undefined } as never)
  const registry = ctx.plugin(Registry)
  await registry
  const facade = ctx.plugin(runtime)
  await facade
  // A root-context call bypasses Cordis dependency checks and cannot catch browser regressions.
  let client = ctx.plugin(apply)
  await client
  t.after(async () => { await client.dispose(); await facade.dispose(); await registry.dispose() })
  await settle()
  assert.ok(command, 'mount contribution before registering the command')
  const options = await command.ui.options(SESSION, new AbortController().signal)
  await command.ui.onSelect(options[3]!, SESSION)
  assert.deepEqual(calls.map(({ endpoint, args }) => ({ endpoint, args })), [
    { endpoint: 'providerExtraTiers/describe', args: { provider: ROUTE.provider, model: ROUTE.model } },
    { endpoint: 'providerExtraTiers/select', args: { provider: ROUTE.provider, model: ROUTE.model, tier: 'priority' } },
  ])
  assert.equal(calls.every(call => call.signal instanceof AbortSignal), true)
  await client.dispose()
  assert.equal(Boolean(command), false)
  assert.equal(ctx.get('remote.providerExtraTiers'), undefined)
  client = ctx.plugin(apply)
  await client
  await settle()
  const reopened = await command!.ui.options(SESSION, new AbortController().signal)
  await command!.ui.onSelect(reopened[0]!, SESSION)
  assert.deepEqual(calls.at(-1)!.args, { provider: ROUTE.provider, model: ROUTE.model })
})

test('published artifact VM-loads without runtime imports or Node globals', () => {
  execFileSync(process.execPath, ['tools/build-client.mjs'], { cwd: ROOT })
  const artifact = readFileSync(new URL('dist/client.js', ROOT), 'utf8')
  let loaded: { id: string; factory(require: (id: string) => never): Record<string, unknown> } | undefined
  runInNewContext(artifact, { window: { __ModuleLoader__: { load(value: typeof loaded) { loaded = value } } } })
  assert.equal(loaded!.id, '@sagmans/dsh-provider-extra')
  const exports = loaded!.factory(id => { throw new Error('Unexpected runtime dependency: ' + id) })
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.TIER_DEFAULT, TIER_DEFAULT)
  assert.doesNotMatch(artifact, /\b(?:process|Buffer|__dirname|__filename)\b/)
})