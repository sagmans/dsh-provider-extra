/** Authentication changes credentials, never the managed profile's route ownership. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordKeyFor } from '../src/codex.ts'
import { AGENT, COMMAND, ENDPOINT, KEY, MODEL, OLD_KEY, REF, ROUTE, SESSION, SOURCE,
  MemoryCredentials, catalog, completionResponse, mountLogin } from './login-host-fixture.ts'

const SOURCE_RECORD = recordKeyFor(SOURCE)
const RENAMED_COMMAND = 'configured-login'
const REJECTION = 'local provider rejected candidate'

test('managed login persists exact reference after configured-route proof without changing membership or defaults', async t => {
  const store = new MemoryCredentials()
  store.records.set(SOURCE_RECORD, { kind: 'api-key', key: OLD_KEY })
  const config = { catalog: catalog() }
  const before = structuredClone(config)
  const seen: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push(request.url)
    assert.equal(request.url, ENDPOINT + '/chat/completions')
    assert.equal(request.headers.get('authorization'), 'Bearer ' + KEY)
    assert.equal(request.headers.get('x-opencode-session'), SESSION)
    assert.equal(request.headers.get('x-login-test'), SESSION)
    assert.equal((await request.json() as { model: string }).model, MODEL)
    return completionResponse()
  })
  const { ctx, run } = await mountLogin(t, { config, credentials: store })
  const defaults = ctx.get('agentDefaultModel')
  const result = await run(ROUTE + ' key')
  assert.equal(result.kind, 'success', JSON.stringify(result))
  assert.equal(store.values.get(REF), KEY)
  assert.deepEqual(store.records.get(SOURCE_RECORD), { kind: 'api-key', key: OLD_KEY })
  assert.deepEqual(store.writes, [REF])
  assert.deepEqual(config, before)
  assert.deepEqual(ctx.llm.listProviders(), [{ id: ROUTE, name: 'Configured Go' }])
  assert.deepEqual(defaults.currentSelection(), before.catalog.default)
  assert.equal(ctx.get('agentDefaultModel'), defaults)
  const prepared = await ctx.llm.prepareCall(before.catalog.default)
  for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) {
    if (chunk.type === 'finish') assert.notEqual(chunk.reason.kind, 'error')
  }
  assert.equal(seen.length, 2, 'the next dispatch must consume the exact committed reference')
})

test('managed status names only configured routes and does not substitute a source record for an unset reference', async t => {
  const store = new MemoryCredentials()
  store.records.set(SOURCE_RECORD, { kind: 'api-key', key: OLD_KEY })
  const { run } = await mountLogin(t, { credentials: store })
  const result = await run('status')
  assert.equal(result.kind, 'success')
  assert.ok((result.text ?? '').includes(REF + ' (not set)'))
  assert.doesNotMatch(result.text ?? '', /OpenAI|signed in \(api_key\)/u)
  assert.deepEqual(store.writes, [])
})

test('record-backed managed alias persists only the configured source record', async t => {
  t.mock.method(globalThis, 'fetch', async () => completionResponse())
  const { store, run } = await mountLogin(t, { config: { catalog: catalog(true) } })
  const result = await run(ROUTE + ' key')
  assert.equal(result.kind, 'success', JSON.stringify(result))
  assert.deepEqual(store!.records.get(SOURCE_RECORD), { kind: 'api-key', key: KEY })
  assert.equal(store!.records.has(recordKeyFor(ROUTE)), false)
  assert.deepEqual(store!.writes, [SOURCE_RECORD])
  assert.match((await run('status')).text ?? '', /signed in \(api_key\)/u)
})

for (const condition of ['missing', 'read-only', 'write-failure', 'rejected', 'cancelled', 'empty-models'] as const) {
  test('managed key login preserves old credentials when ' + condition, async t => {
    const store = new MemoryCredentials()
    store.values.set(REF, OLD_KEY)
    store.writable = condition !== 'read-only'
    store.failWrite = condition === 'write-failure'
    const controller = new AbortController()
    const config = { catalog: catalog() }
    if (condition === 'empty-models') { config.catalog.providers[0]!.models = []; config.catalog.default = null as never }
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
      requests++
      if (condition === 'cancelled') controller.abort(new Error('local login cancelled'))
      if (condition === 'rejected') return Response.json({ error: { message: REJECTION } }, { status: 401 })
      return completionResponse()
    })
    const { run, prompts } = await mountLogin(t, { config, credentials: condition === 'missing' ? null : store })
    const result = await run(ROUTE + ' key', controller.signal)
    assert.equal(result.kind, 'error', JSON.stringify(result))
    assert.equal(store.values.get(REF), OLD_KEY)
    assert.deepEqual(store.writes, [])
    if (condition === 'missing' || condition === 'read-only') { assert.equal(prompts.length, 0); assert.equal(requests, 0) }
    if (condition === 'empty-models') assert.match(result.text, /cannot verify.*no models/u)
  })
}

test('unknown picker text refuses with its typed route and the configured candidates', async t => {
  const typed = 'not-configured key'
  const { run, prompts, store } = await mountLogin(t, { ask: async request => ({
    answers: [{ id: request.questions[0]!.id, selected: [], custom: typed }],
  }) })
  const result = await run('')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes(typed))
  assert.ok(result.text.includes(ROUTE))
  assert.equal(prompts.length, 1)
  assert.deepEqual(store!.writes, [])
})

test('ambiguous case-insensitive route input refuses and names both configured candidates', async t => {
  const config = { catalog: catalog() }
  const exact = 'Team-A'
  const alternate = 'team-a'
  config.catalog.providers = [exact, alternate].map(id => ({ ...config.catalog.providers[0]!, id }))
  config.catalog.default.provider = exact
  const { run, prompts, store } = await mountLogin(t, { config })
  const result = await run('TEAM-A key')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('TEAM-A key'))
  assert.ok(result.text.includes(exact))
  assert.ok(result.text.includes(alternate))
  assert.equal(prompts.length, 0)
  assert.deepEqual(store!.writes, [])
})

test('managed mode honors the command enablement and name options', async t => {
  const disabled = await mountLogin(t, { config: { catalog: catalog(), loginCommandEnabled: false } })
  assert.equal(disabled.ctx.commands.find(AGENT, COMMAND), undefined)
  const enabled = await mountLogin(t, { config: { catalog: catalog(), loginCommandName: RENAMED_COMMAND } })
  assert.equal(enabled.ctx.commands.find(AGENT, COMMAND), undefined)
  assert.equal((await enabled.run('status', undefined, RENAMED_COMMAND)).kind, 'success')
})

test('legacy Go login writes its named reference and probes its configured route', async t => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    assert.equal(request.url, ENDPOINT + '/chat/completions')
    assert.equal(request.headers.get('x-opencode-session'), SESSION)
    return completionResponse()
  })
  const { run, store } = await mountLogin(t, { config: { routeId: ROUTE, apiKeyEnv: REF, baseURL: ENDPOINT,
    fallbackSessionId: SESSION, models: [MODEL], codexEnabled: false } })
  const result = await run(SOURCE + ' key')
  assert.equal(result.kind, 'success', JSON.stringify(result))
  assert.match(result.text ?? '', /route reads it/u)
  assert.equal(store!.values.get(REF), KEY)
  assert.deepEqual(store!.writes, [REF])
})

test('ownership lost during the secret prompt prevents the configured key probe', async t => {
  let conflict = async () => {}
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return completionResponse() })
  const { ctx, run, store } = await mountLogin(t, { ask: async request => {
    await conflict()
    return { answers: request.questions.map(question => ({ id: question.id, selected: [], custom: KEY })) }
  } })
  conflict = async () => {
    const external = await ctx.plugin({ inject: ['llm'], apply(owner) {
      owner.llm.registerConfigurableProviders([{ provider: 'outside', displayName: 'Outside', settingsNs: 'outside', settingsPath: ['outside'] }])
    } })
    t.after(() => external.dispose())
  }
  const result = await run(ROUTE + ' key')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /CATALOG_OWNER_COLLISION/u)
  assert.equal(requests, 0)
  assert.deepEqual(store!.writes, [])
})
