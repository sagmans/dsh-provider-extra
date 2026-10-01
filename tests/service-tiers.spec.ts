/** Tier choices must survive restart and reach both upstream stream entry points. */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { normalizeContext } from '@earendil-works/pi-ai'
import { createTierSelection, withServiceTiers, mountServiceTiers } from '../src/service-tiers.ts'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { MemoryCredentials } from './login-host-fixture.ts'
import { recordKeyFor } from '../src/codex.ts'
import { buildCodexProfile, DEFAULT_CODEX_ROUTE_ID } from '../src/codex.ts'
import { TIER_CONTRIBUTION, TIER_NAMESPACE } from '../src/tier-client.ts'

const PROVIDER = DEFAULT_CODEX_ROUTE_ID
const MODEL = 'gpt-5.6-luna'
const PRIORITY = 'priority'
const UNKNOWN = 'ultrafast'
const STANDARD = 'default'
const AUTO = 'auto'
const FAST_ALIAS = 'fast'
const STANDARD_ALIAS = 'standard'
const PROVIDER_DEFAULT = 'provider-default'
const UNKNOWN_MODEL = 'example-unsupported-model'
const STREAMS = ['stream', 'streamSimple'] as const
const AUTH_KEY = 'example-tier-key'
const TEMPERATURE = 0.25
const INVOCATION_CASES = [[STANDARD_ALIAS, STANDARD], [FAST_ALIAS, PRIORITY], [AUTO, AUTO], [PROVIDER_DEFAULT, undefined]] as const

it('mounts the remote after providing tier policy and disposes its registration', async t => {
  const ctx = new Context()
  let registrations = 0
  ctx.provide('typert', { register(contribution: { invocations: unknown }) {
    assert.equal(contribution.invocations, TIER_CONTRIBUTION.descriptors)
    assert.ok(ctx.get('providerServiceTiers'))
    registrations++
    return async () => { registrations-- }
  } } as never)
  const mounted = await ctx.plugin(owner => {
    mountServiceTiers(owner, {}, () => new Map([[PROVIDER, buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })]]))
  })
  t.after(() => mounted.dispose())
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(registrations, 1)
  assert.ok(ctx.get(TIER_NAMESPACE))
  await mounted.dispose()
  assert.equal(registrations, 0)
  assert.equal(ctx.get(TIER_NAMESPACE), undefined)
})

it('persists choices before reporting success and clears explicit selection', async () => {
  let stored: { provider: string; model: string; tier: string }[] = []
  const service = createTierSelection((provider, model) => stored.find(entry => entry.provider === provider && entry.model === model)?.tier, async (provider, model, tier) => { stored = tier === null ? [] : [{ provider, model, tier }] }, () => new Map([[PROVIDER, buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })]]))
  assert.deepEqual(service.choices(PROVIDER, MODEL).map(row => row.id), ['auto', 'default', PRIORITY])
  await service.select(PROVIDER, MODEL, PRIORITY)
  assert.equal(service.current(PROVIDER, MODEL), PRIORITY)
  assert.equal(createTierSelection((provider, model) => stored.find(entry => entry.provider === provider && entry.model === model)?.tier, async () => {}, () => new Map()).current(PROVIDER, MODEL), PRIORITY)
  await assert.rejects(service.select(PROVIDER, MODEL, UNKNOWN))
  assert.equal(service.current(PROVIDER, MODEL), PRIORITY)
  await service.select(PROVIDER, MODEL, undefined)
  assert.equal(service.current(PROVIDER, MODEL), undefined)
  assert.deepEqual(service.choices('other', MODEL), [])
})

it('does not apply a choice when durable persistence fails', async () => {
  const service = createTierSelection(() => undefined, async () => { throw new Error('read-only') }, () => new Map([[PROVIDER, buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })]]))
  await assert.rejects(service.select(PROVIDER, MODEL, PRIORITY), /read-only/)
  assert.equal(service.current(PROVIDER, MODEL), undefined)
})

it('forwards tier through both streams without mutating the original options', async () => {
  const original = buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })
  const received: unknown[] = []
  const source = original.piProvider!
  const profile = { ...original, piProvider: { ...source, stream: (_model: unknown, _context: unknown, options: unknown) => { received.push(options); return undefined as never }, streamSimple: (_model: unknown, _context: unknown, options: unknown) => { received.push(options); return undefined as never } } }
  const routed = withServiceTiers(new Map([[PROVIDER, profile]]), () => PRIORITY).get(PROVIDER)!.piProvider!
  const model = source.getModels().find(entry => entry.id === MODEL)!
  const options = { temperature: 0.5, onPayload: () => ({ preserved: true }) }
  for (const supplied of [options, undefined]) {
    routed.stream(model, normalizeContext({ messages: [] }), supplied)
    routed.streamSimple(model, normalizeContext({ messages: [] }), supplied)
    for (const forwarded of received.splice(0) as { temperature?: number; serviceTier: string; onPayload(payload: unknown, wireModel: typeof model): Promise<unknown> }[]) {
      assert.equal(forwarded.temperature, supplied?.temperature)
      assert.equal(forwarded.serviceTier, PRIORITY)
      assert.deepEqual(await forwarded.onPayload({}, model), { ...(supplied === undefined ? {} : { preserved: true }), service_tier: PRIORITY })
    }
  }
  assert.deepEqual(options.onPayload(), { preserved: true })
  assert.equal(options.temperature, 0.5)
})

/** Independent mounted profiles must see shared preferences without profile reconciliation. */
it('reads fresh shared records across owners and preserves configured fallback until explicit override', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tier-selection-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = { serviceTierSelections: [{ provider: PROVIDER, model: MODEL, tier: PRIORITY }], unrelated: true }
  const original = JSON.stringify(config)
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, original)
  const mount = async () => {
    const ctx = new Context()
    ctx.provide('profileContext', { home } as never)
    const owner = await ctx.plugin(scope => {
      mountServiceTiers(scope, config, () => new Map([[PROVIDER, buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })]]))
    })
    t.after(() => owner.dispose())
    return ctx.providerServiceTiers
  }
  const first = await mount()
  const second = await mount()
  assert.equal(first.current(PROVIDER, MODEL), PRIORITY)
  await first.select(PROVIDER, MODEL, STANDARD)
  assert.equal(second.current(PROVIDER, MODEL), STANDARD)
  await second.select(PROVIDER, MODEL, undefined)
  assert.equal(first.current(PROVIDER, MODEL), undefined)
  assert.equal((await mount()).current(PROVIDER, MODEL), undefined)
  assert.equal(JSON.stringify(config), original)
  assert.equal(await readFile(configPath, 'utf8'), original)
})

it('refuses writes without resolved home and never uses profile editing', async t => {
  const ctx = new Context()
  ctx.provide('configEditor', { edit() { assert.fail('profile writes are forbidden') } } as never)
  const owner = await ctx.plugin(scope => {
    mountServiceTiers(scope, { serviceTierSelections: [{ provider: PROVIDER, model: MODEL, tier: PRIORITY }] }, () => new Map([[PROVIDER, buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })]]))
  })
  t.after(() => owner.dispose())
  const service = ctx.providerServiceTiers
  await assert.rejects(service.select(PROVIDER, MODEL, STANDARD), /resolved profileContext.home is required/)
  assert.equal(service.current(PROVIDER, MODEL), PRIORITY)
  assert.throws(() => plugin.Config({ serviceTierSelections: [{ provider: PROVIDER, model: MODEL, tier: UNKNOWN }] } as never))
})

/** Invocation aliases must never become durable selections. */
it('resolves invocation aliases against authoritative choices without persistence', () => {
  const stored = [{ provider: PROVIDER, model: MODEL, tier: PRIORITY }]
  const service = createTierSelection((provider, model) => stored.find(entry => entry.provider === provider && entry.model === model)?.tier, async () => assert.fail('invocation must not write'),
    () => new Map([[PROVIDER, buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })]]))
  for (const [override, expected] of [[FAST_ALIAS, PRIORITY], [STANDARD_ALIAS, STANDARD], [PROVIDER_DEFAULT, null], [AUTO, AUTO], [STANDARD, STANDARD], [PRIORITY, PRIORITY]] as const) {
    assert.equal(service.resolve(PROVIDER, MODEL, override), expected)
    assert.equal(service.current(PROVIDER, MODEL), PRIORITY)
    assert.throws(() => service.resolve(PROVIDER, UNKNOWN_MODEL, override), /unsupported service tier/)
    assert.throws(() => service.resolve(UNKNOWN, MODEL, override), /unsupported service tier/)
  }
  for (const override of [UNKNOWN, '', 'toString', '__proto__']) {
    assert.throws(() => service.resolve(PROVIDER, MODEL, override), /unsupported service tier/)
  }
  assert.deepEqual(stored, [{ provider: PROVIDER, model: MODEL, tier: PRIORITY }])
})

for (const stream of STREAMS) {
  it('gives invocation tiers precedence and isolates later ' + stream + ' calls', async () => {
    const original = buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })
    const source = original.piProvider!
    const model = source.getModels().find(entry => entry.id === MODEL)!
    type Options = import('@earendil-works/pi-ai').StreamOptions & { serviceTier?: string | null }
    const received: Options[] = []
    const profile = { ...original, piProvider: { ...source, [stream]: (_model: unknown, _context: unknown, options: Options) => {
      received.push(options)
      return undefined as never
    } } }
    const routed = withServiceTiers(new Map([[PROVIDER, profile]]), () => PRIORITY).get(PROVIDER)!.piProvider!
    const context = normalizeContext({ messages: [] })
    const onPayload = async () => ({ preserved: true })
    const base = { apiKey: AUTH_KEY, temperature: TEMPERATURE, onPayload }
    for (const tier of [STANDARD, AUTO, PRIORITY, null, undefined]) {
      const options = { ...base, serviceTier: tier }
      routed[stream](model, context, options)
      const forwarded = received.pop()!
      const expected = tier === undefined ? PRIORITY : tier
      assert.equal(forwarded.apiKey, AUTH_KEY)
      assert.equal(forwarded.temperature, TEMPERATURE)
      assert.equal(forwarded.serviceTier, expected ?? undefined)
      assert.equal(Object.hasOwn(forwarded, 'serviceTier'), expected !== null)
      assert.deepEqual(await forwarded.onPayload!({}, model), { preserved: true, ...(expected === null ? {} : { service_tier: expected }) })
      assert.equal(options.onPayload, onPayload)
      assert.equal(options.serviceTier, tier)
      routed[stream](model, context, base)
      assert.equal(received.pop()!.serviceTier, PRIORITY)
    }
  })
}

const ACCOUNT = 'tier-local-account'
const AUTH_CLAIM = 'https://api.openai.com/auth'
const ACCESS = ['header', Buffer.from(JSON.stringify({ [AUTH_CLAIM]: { chatgpt_account_id: ACCOUNT } })).toString('base64url'), 'signature'].join('.')
const GRANT = { type: 'oauth', access: ACCESS, refresh: 'tier-local-refresh', expires: Number.MAX_SAFE_INTEGER, accountId: ACCOUNT }
const RESPONSE = 'data: ' + JSON.stringify({ type: 'response.completed', response: {
  id: 'tier-local-response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
} }) + '\n\n'
const ALIAS = 'codex-tier-alias'

/** Codex transport option pinning must retain invocation overrides and the existing grant. */
for (const stream of STREAMS) {
  it('serializes isolated Codex invocation tiers through ' + stream, async t => {
    const original = buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER, transport: 'sse' })
    const profiles = new Map([[PROVIDER, original]])
    const stored = [{ provider: PROVIDER, model: MODEL, tier: PRIORITY }]
    const selection = createTierSelection((provider, model) => stored.find(entry => entry.provider === provider && entry.model === model)?.tier, async () => assert.fail('invocations must not persist'), () => profiles)
    const provider = withServiceTiers(profiles, selection.current).get(PROVIDER)!.piProvider!
    const model = provider.getModels().find(entry => entry.id === MODEL)!
    const payloads: Record<string, unknown>[] = []
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      assert.equal(request.headers.get('authorization'), 'Bearer ' + ACCESS)
      const body = Buffer.from(await request.arrayBuffer())
      const decoded = request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(body) : body
      payloads.push(JSON.parse(decoded.toString()) as Record<string, unknown>)
      return new Response(RESPONSE, { headers: { 'content-type': 'text/event-stream' } })
    })
    for (const [override, expected] of INVOCATION_CASES) {
      const options = { apiKey: ACCESS, serviceTier: selection.resolve(PROVIDER, MODEL, override) }
      for await (const event of provider[stream](model, normalizeContext({ messages: [] }), options)) assert.notEqual(event.type, 'error', JSON.stringify(event))
      const actual = payloads.pop()!
      assert.equal(actual.service_tier, expected)
      assert.equal(Object.hasOwn(actual, 'service_tier'), expected !== undefined)
      for await (const event of provider[stream](model, normalizeContext({ messages: [] }), { apiKey: ACCESS })) assert.notEqual(event.type, 'error', JSON.stringify(event))
      assert.equal(payloads.pop()!.service_tier, PRIORITY)
    }
    assert.equal(selection.current(PROVIDER, MODEL), PRIORITY)
  })
}

/** Real harness and pi-ai dispatch must serialize the paid tier, not merely retain a UI option. */
for (const managed of [false, true]) for (const tier of [PRIORITY, undefined]) {
  it('serializes ' + (tier ?? 'implicit default') + ' through ' + (managed ? 'managed aliased' : 'additive') + ' Codex adapter', async t => {
    const ctx = new Context()
    const runtime = await ctx.plugin(LlmRuntime)
    t.after(() => runtime.dispose())
    const store = new MemoryCredentials()
    store.records.set(recordKeyFor(PROVIDER), { kind: 'grant', payload: GRANT })
    const credentials = await ctx.plugin((owner: Context) => owner.provide('credentials', store as never))
    t.after(() => credentials.dispose())
    const route = managed ? ALIAS : PROVIDER
    const config = {
      loginCommandEnabled: false,
      serviceTierSelections: tier === undefined ? [] : [{ provider: route, model: MODEL, tier }],
      ...(managed ? { catalog: { version: 1, providers: [{ id: route, name: route, source: PROVIDER, auth: { credentialProvider: PROVIDER }, transport: 'sse', models: [{ id: MODEL, name: MODEL }] }], default: { provider: route, model: MODEL } } }
        : { codexTransport: 'sse', codexModels: [MODEL] }),
    }
    const mounted = await ctx.plugin(plugin, config as never)
    t.after(() => mounted.dispose())
    assert.equal(ctx.providerServiceTiers.choices(route, MODEL).length, 3)
    const payloads: Record<string, unknown>[] = []
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      assert.equal(request.headers.get('authorization'), 'Bearer ' + ACCESS)
      const body = Buffer.from(await request.arrayBuffer())
      // Codex compresses its wire body; decoding it proves the actual serialized policy.
      const decoded = request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(body) : body
      payloads.push(JSON.parse(decoded.toString()) as Record<string, unknown>)
      return new Response(RESPONSE, { headers: { 'content-type': 'text/event-stream' } })
    })
    const prepared = await ctx.llm.prepareCall({ provider: route, model: MODEL })
    const chunks = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)
    assert.equal(payloads.length, 1, JSON.stringify(chunks))
    assert.equal(payloads[0]!.service_tier, tier)
    assert.equal(Object.hasOwn(payloads[0]!, 'service_tier'), tier !== undefined)
    assert.equal(payloads[0]!.model, MODEL)
  })
}
