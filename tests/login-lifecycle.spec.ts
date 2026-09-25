/** Minted grants and already-started atomic writes outlive later cancellation verdicts. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { OAuthCredential, ProviderAuthInteraction } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { compileCatalog } from '../src/catalog.ts'
import { mountLoginCommand } from '../src/login-host.ts'
import { recordKeyFor } from '../src/codex.ts'
import { AGENT, COMMAND, KEY, OLD_KEY, REF, ROUTE, SOURCE, MemoryCredentials, catalog, completionResponse, mountLogin } from './login-host-fixture.ts'

const CODEX_SOURCE = 'openai-codex'
const CODEX_ROUTE = 'subscription-alias'
const CODEX_MODEL = 'gpt-5.4'
const XAI_SOURCE = 'xai'
const XAI_MODEL = builtinProviders().find(provider => provider.id === XAI_SOURCE)!.getModels()[0]!.id
const GRANT: OAuthCredential = { type: 'oauth', access: 'local-access', refresh: 'local-refresh', expires: Number.MAX_SAFE_INTEGER }
const PREVIOUS_GRANT: OAuthCredential = { ...GRANT, access: 'previous-local-access', refresh: 'previous-local-refresh' }
const COLLISION = 'CATALOG_OWNER_COLLISION'
const CANCELLED = 'local caller cancelled'

/** Only the OAuth conversation is replaced; command and durable store code stay real. */
async function mountSubscription(t: TestContext, flow: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>,
  guard = () => {}, store: MemoryCredentials | null = new MemoryCredentials(), source = CODEX_SOURCE) {
  const model = source === CODEX_SOURCE ? CODEX_MODEL : XAI_MODEL
  const snapshot = compileCatalog({ version: 1, providers: [{ id: CODEX_ROUTE, name: 'Configured subscription',
    source, auth: { credentialProvider: source }, models: [{ id: model, name: 'Configured model' }] }],
    default: { provider: CODEX_ROUTE, model } })!
  const profiles = new Map(snapshot.profiles)
  const profile = profiles.get(CODEX_ROUTE)!
  const provider = profile.piProvider!
  profiles.set(CODEX_ROUTE, { ...profile, piProvider: { ...provider, auth: {
    ...provider.auth,
    oauth: { ...provider.auth.oauth!, login: flow },
  } } })
  const ctx = new Context()
  const commands = await ctx.plugin(CommandRuntime)
  t.after(() => commands.dispose())
  if (store !== null) {
    const credentials = await ctx.plugin((owner: Context) => owner.provide('credentials', store as never))
    t.after(() => credentials.dispose())
  }
  const mounted = await ctx.plugin((owner: Context) => mountLoginCommand(owner, {
    loginCommandEnabled: true, loginCommandName: COMMAND, routeId: ROUTE, codexRouteId: CODEX_ROUTE, apiKeyEnv: REF,
  }, { catalog: snapshot, profiles: () => profiles, requireOwnership: guard }))
  t.after(() => mounted.dispose())
  return { store, run: async (signal: AbortSignal) => ctx.commands.find(AGENT, COMMAND)!.handler({
    commandId: 'local-subscription-login', agent: AGENT, rawInput: CODEX_ROUTE, attachments: [], signal,
  } as unknown as CommandInvocation) }
}

test('managed OAuth replaces the previous source record exactly once only after the flow returns a grant', async t => {
  const store = new MemoryCredentials()
  const key = recordKeyFor(CODEX_SOURCE)
  store.records.set(key, { kind: 'grant', payload: PREVIOUS_GRANT })
  let entered!: () => void
  let release!: (grant: OAuthCredential) => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise<OAuthCredential>(resolve => { release = resolve })
  const { run } = await mountSubscription(t, async () => { entered(); return pending }, undefined, store)
  const login = run(new AbortController().signal)
  await started
  try {
    assert.deepEqual(store.records.get(key), { kind: 'grant', payload: PREVIOUS_GRANT })
    assert.deepEqual(store.writes, [], 'an unfinished OAuth flow has no credential to commit')
  } finally { release(GRANT) }
  assert.equal((await login).kind, 'success')
  assert.deepEqual(store.records.get(key), { kind: 'grant', payload: GRANT })
  assert.deepEqual(store.writes, [key])
  assert.deepEqual([...store.records.keys()], [key])
})

test('cancelled managed OAuth flow preserves the previous source record without writing', async t => {
  const controller = new AbortController()
  const store = new MemoryCredentials()
  const key = recordKeyFor(CODEX_SOURCE)
  store.records.set(key, { kind: 'grant', payload: PREVIOUS_GRANT })
  const { run } = await mountSubscription(t, async interaction => {
    controller.abort(new Error(CANCELLED))
    interaction.signal.throwIfAborted()
    return GRANT
  }, undefined, store)
  const result = await run(controller.signal)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /sign-in was cancelled/u)
  assert.deepEqual(store.records.get(key), { kind: 'grant', payload: PREVIOUS_GRANT })
  assert.deepEqual(store.writes, [])
})

test('managed OAuth reports StoredCredentialError when ownership is lost after persistence', async t => {
  const controller = new AbortController()
  const store = new MemoryCredentials()
  const key = recordKeyFor(CODEX_SOURCE)
  store.records.set(key, { kind: 'grant', payload: PREVIOUS_GRANT })
  let conflict = false
  const modify = store.modifyRecord.bind(store)
  t.mock.method(store, 'modifyRecord', async (...args: Parameters<typeof modify>) => {
    const committed = await modify(...args)
    assert.deepEqual(store.records.get(key), { kind: 'grant', payload: GRANT })
    conflict = true
    controller.abort(new Error(CANCELLED))
    return committed
  })
  const { run } = await mountSubscription(t, async () => GRANT, () => { if (conflict) throw new Error(COLLISION) }, store)
  assert.deepEqual(await run(controller.signal), { kind: 'error',
    text: 'The credential was stored, but the route is unavailable: ' + COLLISION })
  assert.deepEqual(store.records.get(key), { kind: 'grant', payload: GRANT })
  assert.deepEqual(store.writes, [key])
})

test('dual-method managed XAI defaults to OAuth without a method word', async t => {
  const source = builtinProviders().find(provider => provider.id === XAI_SOURCE)!
  assert.equal(typeof source.auth.apiKey?.login, 'function')
  assert.equal(typeof source.auth.oauth?.login, 'function')
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('default OAuth choice must not attempt a key probe') })
  let logins = 0
  const store = new MemoryCredentials()
  const { run } = await mountSubscription(t, async () => { logins++; return GRANT }, undefined, store, XAI_SOURCE)
  const result = await run(new AbortController().signal)
  assert.equal(result.kind, 'success', JSON.stringify(result))
  assert.equal(logins, 1)
  assert.deepEqual(store.records.get(recordKeyFor(XAI_SOURCE)), { kind: 'grant', payload: GRANT })
  assert.deepEqual(store.writes, [recordKeyFor(XAI_SOURCE)])
})

for (const event of ['cancelled', 'ownership-conflict', 'cancelled-and-conflicted'] as const) {
  test('minted OAuth grant persists at source identity despite later ' + event, async t => {
    const controller = new AbortController()
    let conflict = false
    const { store, run } = await mountSubscription(t, async () => {
      if (event !== 'ownership-conflict') controller.abort(new Error(CANCELLED))
      if (event !== 'cancelled') conflict = true
      return GRANT
    }, () => { if (conflict) throw new Error(COLLISION) })
    const result = await run(controller.signal)
    assert.deepEqual(store!.records.get(recordKeyFor(CODEX_SOURCE)), { kind: 'grant', payload: GRANT })
    assert.deepEqual(store!.writes, [recordKeyFor(CODEX_SOURCE)])
    assert.equal(store!.records.has(recordKeyFor(CODEX_ROUTE)), false)
    if (event === 'cancelled') assert.equal(result.kind, 'success', JSON.stringify(result))
    else { assert.equal(result.kind, 'error'); assert.match(result.text, /credential was stored.*CATALOG_OWNER_COLLISION/u) }
  })
}

for (const unavailable of ['missing', 'read-only'] as const) {
  test('OAuth refuses ' + unavailable + ' persistence before minting a grant', async t => {
    let logins = 0
    const store = new MemoryCredentials()
    store.writable = false
    const { run } = await mountSubscription(t, async () => { logins++; return GRANT }, undefined, unavailable === 'missing' ? null : store)
    assert.equal((await run(new AbortController().signal)).kind, 'error')
    assert.equal(logins, 0)
    assert.deepEqual(store.writes, [])
  })
}

test('an already-started reference write reports persisted state after cancellation', async t => {
  const controller = new AbortController()
  const store = new MemoryCredentials()
  const set = store.set.bind(store)
  t.mock.method(store, 'set', async (ref: string, value: string) => { controller.abort(new Error(CANCELLED)); await set(ref, value) })
  t.mock.method(globalThis, 'fetch', async () => completionResponse())
  const { run } = await mountLogin(t, { credentials: store })
  const result = await run(ROUTE + ' key', controller.signal)
  assert.equal(result.kind, 'success', JSON.stringify(result))
  assert.equal(store.values.get(REF), KEY)
  assert.match(result.text ?? '', /credential is stored/u)
})

test('readback failure after a completed reference write preserves durable state in its cancellation report', async t => {
  const controller = new AbortController()
  const store = new MemoryCredentials()
  const set = store.set.bind(store)
  t.mock.method(store, 'set', async (ref: string, value: string) => {
    await set(ref, value)
    controller.abort(new Error(CANCELLED))
  })
  t.mock.method(store, 'resolve', async () => { throw new Error('local readback failed') })
  t.mock.method(globalThis, 'fetch', async () => completionResponse())
  const { run } = await mountLogin(t, { credentials: store })
  const result = await run(ROUTE + ' key', controller.signal)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /credential was stored.*local readback failed/u)
  assert.equal(store.values.get(REF), KEY)
})

test('a cancelled queued record update never replaces the previous API key', async t => {
  const controller = new AbortController()
  const store = new MemoryCredentials()
  store.records.set(recordKeyFor(SOURCE), { kind: 'api-key', key: OLD_KEY })
  const modify = store.modifyRecord.bind(store)
  t.mock.method(store, 'modifyRecord', async (...args: Parameters<typeof modify>) => {
    controller.abort(new Error(CANCELLED))
    return modify(...args)
  })
  t.mock.method(globalThis, 'fetch', async () => completionResponse())
  const { run } = await mountLogin(t, { credentials: store, config: { catalog: catalog(true) } })
  const result = await run(ROUTE + ' key', controller.signal)
  assert.equal(result.kind, 'error')
  assert.deepEqual(store.records.get(recordKeyFor(SOURCE)), { kind: 'api-key', key: OLD_KEY })
  assert.deepEqual(store.writes, [])
})

test('a named xai reference cannot select OAuth or create a provider grant', async t => {
  const config = { catalog: { version: 1, providers: [{ id: XAI_SOURCE, name: 'XAI', source: XAI_SOURCE,
    auth: { apiKeyRef: REF }, models: [{ id: XAI_MODEL, name: 'XAI model' }] }], default: { provider: XAI_SOURCE, model: XAI_MODEL } } }
  const { run, store, prompts } = await mountLogin(t, { config })
  const result = await run(XAI_SOURCE + ' oauth')
  assert.equal(result.kind, 'error')
  assert.equal(prompts.length, 0)
  assert.deepEqual(store!.writes, [])
})
