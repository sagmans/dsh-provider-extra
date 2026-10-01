/** Wire assertions protect paid policy from protocol-compatible routes and upstream option filtering. */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { zstdDecompressSync } from 'node:zlib'
import { buildCodexProfile } from '../src/codex.ts'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { normalizeContext } from '@earendil-works/pi-ai'
import type { Api, StreamOptions } from '@earendil-works/pi-ai'
import * as plugin from '../src/index.ts'
import { buildCatalogProfile } from '../src/catalog-routes.ts'
import type { CatalogProvider } from '../src/catalog.ts'
import { createTierSelection, withServiceTiers } from '../src/service-tiers.ts'
import { MemoryCredentials } from './login-host-fixture.ts'

const OPENAI = 'openai'
const CODEX = 'openai-codex'
const OTHER_SOURCE = 'openrouter'
const GO_SOURCE = 'opencode-go'
const ACCOUNT = 'example-tier-account'
const AUTH_CLAIM = 'https://api.openai.com/auth'
const ACCESS = ['header', Buffer.from(JSON.stringify({ [AUTH_CLAIM]: { chatgpt_account_id: ACCOUNT } })).toString('base64url'), 'signature'].join('.')
const RESPONSES = 'openai-responses'
const COMPLETIONS = 'openai-completions'
const APIS = [RESPONSES, COMPLETIONS] as const
const STREAMS = ['stream', 'streamSimple'] as const
const TIERS = ['auto', 'default', 'priority'] as const
const PRIORITY = 'priority'
const INVOCATION_CASES = [
  ['standard', 'default'], ['fast', PRIORITY], ['auto', 'auto'], ['provider-default', undefined],
  ['default', 'default'], [PRIORITY, PRIORITY],
] as const
const INVALID_TIER = 'ultrafast'
const ALIAS = 'example-openai-alias'
const MODEL = 'example-tier-model'
const KEY_REF = 'TIER_WIRE_TEST_KEY'
const KEY = 'local-tier-wire-key'
const ENDPOINT = 'http://127.0.0.1:1/v1'
const HEADER = 'x-tier-test'
const HEADER_VALUE = 'preserved'
const TEMPERATURE = 0.25
const METADATA = { reasoning: false, input: ['text'] as ('text' | 'image')[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }
const ITEM = { type: 'message', id: 'example-tier-message', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
const RESPONSE_BODY = { id: 'example-tier-response', status: 'completed', output: [ITEM], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
const RESPONSE = [
  { type: 'response.created', response: { ...RESPONSE_BODY, status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { ...ITEM, content: [] } },
  { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'ok' },
  { type: 'response.output_item.done', output_index: 0, item: ITEM },
  { type: 'response.completed', response: RESPONSE_BODY },
].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')
const CHAT_RESPONSE = 'data: ' + JSON.stringify({ id: 'example-tier-response', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'

/** Explicit metadata avoids inheriting unrelated model eligibility from a fixture template. */
function route(id: string, api: Api, source?: string): CatalogProvider {
  return { id, name: id, ...(source === undefined ? { api } : { source }), baseURL: ENDPOINT,
    auth: { apiKeyRef: KEY_REF }, models: [{ id: MODEL, name: MODEL, metadata: { ...METADATA, api } }] }
}

for (const api of APIS) {
  const cases = [
    ...(api === RESPONSES ? [
      ...TIERS.map(tier => ({ id: ALIAS, source: OPENAI, tier, eligible: true })),
      { id: OPENAI, source: OPENAI, tier: undefined, eligible: true },
    ] : [{ id: OPENAI, source: OTHER_SOURCE, tier: PRIORITY, eligible: false }]),
    { id: OPENAI, source: undefined, tier: PRIORITY, eligible: false },
    { id: CODEX, source: undefined, tier: PRIORITY, eligible: false },
  ]
  for (const { id, source, tier, eligible } of cases) {
    it('gates and serializes ' + api + ' tier ' + tier + ' for ' + id + ' source ' + source, async t => {
      const ctx = new Context()
      const runtime = await ctx.plugin(LlmRuntime)
      t.after(() => runtime.dispose())
      const store = new MemoryCredentials()
      store.values.set(KEY_REF, KEY)
      const credentials = await ctx.plugin((owner: Context) => owner.provide('credentials', store as never))
      t.after(() => credentials.dispose())
      const mounted = await ctx.plugin(plugin, {
        loginCommandEnabled: false,
        serviceTierSelections: tier === undefined ? [] : [{ provider: id, model: MODEL, tier }],
        catalog: { version: 1, providers: [route(id, api, source)], default: { provider: id, model: MODEL } },
      } as never)
      t.after(() => mounted.dispose())
      assert.deepEqual(ctx.providerServiceTiers.choices(id, MODEL).map(choice => choice.id), eligible ? TIERS : [])
      assert.deepEqual(ctx.providerServiceTiers.choices(id, MODEL + '-missing'), [])
      if (!eligible) {
        await assert.rejects(ctx.providerServiceTiers.select(id, MODEL, PRIORITY), /unsupported service tier/)
        for (const [override] of INVOCATION_CASES) assert.throws(() => ctx.providerServiceTiers.resolve(id, MODEL, override), /unsupported service tier/)
      }
      const payloads: Record<string, unknown>[] = []
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init)
        assert.equal(request.headers.get('authorization'), 'Bearer ' + KEY)
        payloads.push(await request.json() as Record<string, unknown>)
        return new Response(api === RESPONSES ? RESPONSE : CHAT_RESPONSE, { headers: { 'content-type': 'text/event-stream' } })
      })
      const prepared = await ctx.llm.prepareCall({ provider: id, model: MODEL })
      for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) {
        if (chunk.type === 'finish') assert.notEqual(chunk.reason.kind, 'error', JSON.stringify(chunk))
      }
      assert.equal(payloads.length, 1)
      assert.equal(payloads[0]!.model, MODEL)
      assert.equal(payloads[0]!.service_tier, eligible ? tier : undefined)
      assert.equal(Object.hasOwn(payloads[0]!, 'service_tier'), eligible && tier !== undefined)
    })
  }
}

for (const api of APIS) for (const stream of STREAMS) for (const replacement of [false, true]) {
  it('preserves ' + (replacement ? 'replacement' : 'mutating') + ' payload hook and options through ' + api + ' ' + stream, async t => {
    // The installed native catalog publishes only Responses; exercise its older protocol through real pi-ai streams.
    const original = buildCatalogProfile(route(ALIAS, api, api === RESPONSES ? OPENAI : undefined))
    const profiles = new Map([[ALIAS, original]])
    const provider = withServiceTiers(profiles, () => PRIORITY, () => OPENAI).get(ALIAS)!.piProvider!
    const model = provider.getModels()[0]!
    let hookCalls = 0
    const options: StreamOptions = { apiKey: KEY, temperature: TEMPERATURE, headers: { [HEADER]: HEADER_VALUE }, onPayload: async (payload, wireModel) => {
      hookCalls++
      assert.equal(wireModel.id, MODEL)
      const body = payload as Record<string, unknown>
      if (replacement) return { ...body, metadata: { hook: HEADER_VALUE } }
      body.metadata = { hook: HEADER_VALUE }
    } }
    const originalHook = options.onPayload
    const payloads: Record<string, unknown>[] = []
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      assert.equal(request.headers.get('authorization'), 'Bearer ' + KEY)
      assert.equal(request.headers.get(HEADER), HEADER_VALUE)
      payloads.push(await request.json() as Record<string, unknown>)
      return new Response(api === RESPONSES ? RESPONSE : CHAT_RESPONSE, { headers: { 'content-type': 'text/event-stream' } })
    })
    for await (const event of provider[stream](model, normalizeContext({ messages: [] }), options)) assert.notEqual(event.type, 'error', JSON.stringify(event))
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0]!.service_tier, PRIORITY)
    assert.equal(payloads[0]!.temperature, TEMPERATURE)
    assert.deepEqual(payloads[0]!.metadata, { hook: HEADER_VALUE })
    assert.equal(hookCalls, 1)
    assert.equal(options.onPayload, originalHook)
    assert.equal(Object.hasOwn(options, 'serviceTier'), false)
  })
}

/** Profile identity alone cannot prove a model speaks the native source's supported protocol. */
for (const [source, api] of [[CODEX, RESPONSES], [CODEX, COMPLETIONS]] as const) {
  it('rejects source ' + source + ' with API ' + api, async () => {
    const profile = buildCatalogProfile(route(ALIAS, RESPONSES, OPENAI))
    const model = { ...profile.piProvider!.getModels()[0]!, api }
    const profiles = new Map([[ALIAS, { ...profile, piProvider: { ...profile.piProvider!, getModels: () => [model] } }]])
    const selection = createTierSelection(() => undefined, async () => {}, () => profiles, () => source)
    assert.deepEqual(selection.choices(ALIAS, MODEL), [])
    await assert.rejects(selection.select(ALIAS, MODEL, PRIORITY), /unsupported service tier/)
    for (const [override] of INVOCATION_CASES) assert.throws(() => selection.resolve(ALIAS, MODEL, override), /unsupported service tier/)
  })
}

/** A forged native-looking route must not gain subscription policy merely by naming its API. */
for (const source of [OPENAI, GO_SOURCE, undefined]) for (const stream of STREAMS) {
  it('does not send a Codex tier for source ' + source + ' through ' + stream, async t => {
    const original = buildCodexProfile({ provider: OPENAI, displayName: OPENAI, transport: 'sse' })
    const profiles = new Map([[OPENAI, original]])
    const provider = withServiceTiers(profiles, () => PRIORITY, () => source).get(OPENAI)!.piProvider!
    const model = provider.getModels()[0]!
    const selection = createTierSelection(() => undefined, async () => {}, () => profiles, () => source)
    assert.deepEqual(selection.choices(OPENAI, model.id), [])
    const payloads: Record<string, unknown>[] = []
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      assert.equal(request.headers.get('authorization'), 'Bearer ' + ACCESS)
      const body = Buffer.from(await request.arrayBuffer())
      const decoded = request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(body) : body
      payloads.push(JSON.parse(decoded.toString()) as Record<string, unknown>)
      return new Response(RESPONSE, { headers: { 'content-type': 'text/event-stream' } })
    })
    for await (const event of provider[stream](model, normalizeContext({ messages: [] }), { apiKey: ACCESS })) assert.notEqual(event.type, 'error', JSON.stringify(event))
    assert.equal(payloads.length, 1)
    assert.equal(Object.hasOwn(payloads[0]!, 'service_tier'), false)
  })
}

/** Real serializers must respect the callback's null sentinel without contaminating later calls. */
for (const api of APIS) for (const stream of STREAMS) {
  it('serializes invocation aliases without changing shared policy through ' + api + ' ' + stream, async t => {
    const original = buildCatalogProfile(route(ALIAS, api, api === RESPONSES ? OPENAI : undefined))
    const profiles = new Map([[ALIAS, original]])
    const stored = [{ provider: ALIAS, model: MODEL, tier: PRIORITY }]
    const selection = createTierSelection((provider, model) => stored.find(entry => entry.provider === provider && entry.model === model)?.tier, async () => assert.fail('invocations must not persist'), () => profiles, () => OPENAI)
    const provider = withServiceTiers(profiles, selection.current, () => OPENAI).get(ALIAS)!.piProvider!
    const model = provider.getModels()[0]!
    const payloads: Record<string, unknown>[] = []
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      assert.equal(request.headers.get('authorization'), 'Bearer ' + KEY)
      assert.equal(request.headers.get(HEADER), HEADER_VALUE)
      payloads.push(await request.json() as Record<string, unknown>)
      return new Response(api === RESPONSES ? RESPONSE : CHAT_RESPONSE, { headers: { 'content-type': 'text/event-stream' } })
    })
    const base: StreamOptions = { apiKey: KEY, temperature: TEMPERATURE, headers: { [HEADER]: HEADER_VALUE },
      onPayload: payload => ({ ...payload as Record<string, unknown>, metadata: { hook: HEADER_VALUE } }) }
    for (const [override, expected] of INVOCATION_CASES) {
      const options = { ...base, serviceTier: selection.resolve(ALIAS, MODEL, override) }
      for await (const event of provider[stream](model, normalizeContext({ messages: [] }), options)) assert.notEqual(event.type, 'error', JSON.stringify(event))
      const actual = payloads.pop()!
      assert.equal(actual.service_tier, expected)
      assert.equal(Object.hasOwn(actual, 'service_tier'), expected !== undefined)
      assert.equal(actual.temperature, TEMPERATURE)
      assert.deepEqual(actual.metadata, { hook: HEADER_VALUE })
      assert.equal(selection.current(ALIAS, MODEL), PRIORITY)
      for await (const event of provider[stream](model, normalizeContext({ messages: [] }), base)) assert.notEqual(event.type, 'error', JSON.stringify(event))
      assert.equal(payloads.pop()!.service_tier, PRIORITY)
    }
    assert.throws(() => selection.resolve(ALIAS, MODEL, INVALID_TIER), /unsupported service tier/)
    assert.throws(() => selection.resolve(ALIAS, MODEL + '-missing', PRIORITY), /unsupported service tier/)
    assert.deepEqual(payloads, [])
  })
}

it('ignores invalid retained tiers at the provider boundary', async t => {
  const original = buildCatalogProfile(route(ALIAS, RESPONSES, OPENAI))
  const provider = withServiceTiers(new Map([[ALIAS, original]]), () => INVALID_TIER, () => OPENAI).get(ALIAS)!.piProvider!
  const payloads: Record<string, unknown>[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    payloads.push(await new Request(input, init).json() as Record<string, unknown>)
    return new Response(RESPONSE, { headers: { 'content-type': 'text/event-stream' } })
  })
  for await (const event of provider.streamSimple(provider.getModels()[0]!, normalizeContext({ messages: [] }), { apiKey: KEY })) assert.notEqual(event.type, 'error', JSON.stringify(event))
  assert.equal(payloads.length, 1)
  assert.equal(Object.hasOwn(payloads[0]!, 'service_tier'), false)
})
