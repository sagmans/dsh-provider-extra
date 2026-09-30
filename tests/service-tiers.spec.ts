/** Tier choices must survive restart and reach both upstream stream entry points. */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { zstdDecompressSync } from 'node:zlib'
import { normalizeContext } from '@earendil-works/pi-ai'
import { createTierSelection, withServiceTiers, mountServiceTiers } from '../src/service-tiers.ts'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { MemoryCredentials } from './login-host-fixture.ts'
import { recordKeyFor } from '../src/codex.ts'
import { buildCodexProfile, DEFAULT_CODEX_ROUTE_ID } from '../src/codex.ts'

const PROVIDER = DEFAULT_CODEX_ROUTE_ID
const MODEL = 'gpt-5.6-luna'
const PRIORITY = 'priority'
const UNKNOWN = 'ultrafast'

it('persists choices before reporting success and clears explicit selection', async () => {
  let stored: { provider: string; model: string; tier: string }[] = []
  const service = createTierSelection(() => stored, async change => { stored = change(stored) }, () => new Map([[PROVIDER, buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })]]))
  assert.deepEqual(service.choices(PROVIDER, MODEL).map(row => row.id), ['auto', 'default', PRIORITY])
  await service.select(PROVIDER, MODEL, PRIORITY)
  assert.equal(service.current(PROVIDER, MODEL), PRIORITY)
  assert.equal(createTierSelection(() => stored, async () => {}, () => new Map()).current(PROVIDER, MODEL), PRIORITY)
  await assert.rejects(service.select(PROVIDER, MODEL, UNKNOWN))
  assert.equal(service.current(PROVIDER, MODEL), PRIORITY)
  await service.select(PROVIDER, MODEL, undefined)
  assert.equal(service.current(PROVIDER, MODEL), undefined)
  assert.deepEqual(service.choices('other', MODEL), [])
})

it('does not apply a choice when durable persistence fails', async () => {
  const service = createTierSelection(() => [], async () => { throw new Error('read-only') }, () => new Map([[PROVIDER, buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })]]))
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
  routed.stream(model, normalizeContext({ messages: [] }), options)
  routed.streamSimple(model, normalizeContext({ messages: [] }), options)
  for (const forwarded of received as { temperature: number; serviceTier: string; onPayload(payload: unknown, wireModel: typeof model): Promise<unknown> }[]) {
    assert.equal(forwarded.temperature, options.temperature)
    assert.equal(forwarded.serviceTier, PRIORITY)
    assert.deepEqual(await forwarded.onPayload({}, model), { preserved: true, service_tier: PRIORITY })
  }
  assert.deepEqual(options.onPayload(), { preserved: true })
  assert.equal(options.temperature, 0.5)
})

/** The profile lock must preserve unrelated selections made after a picker opened. */
it('uses the profile editor on released schemas and preserves unrelated Config', async () => {
  const other = { provider: 'other', model: 'other-model', tier: PRIORITY }
  const entry = { options: { id: 'provider-row', config: { serviceTierSelections: [] as typeof other[], untouched: true } } }
  const editor = { async edit(target: unknown, change: (raw: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) {
    assert.equal(target, entry)
    entry.options.config = change({ ...entry.options.config, serviceTierSelections: [other] }, {}) as typeof entry.options.config
  } }
  const ctx = { fiber: { entry }, get: (name: string) => name === 'configEditor' ? editor : undefined, inject: () => {}, provide: () => {} } as unknown as Context
  const service = mountServiceTiers(ctx, {}, () => new Map([[PROVIDER, buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })]]))
  await service.select(PROVIDER, MODEL, PRIORITY)
  assert.deepEqual(entry.options.config, { untouched: true, serviceTierSelections: [other, { provider: PROVIDER, model: MODEL, tier: PRIORITY }] })
  assert.equal(service.current(PROVIDER, MODEL), undefined, 'old owner retains its mounted policy')
  const reconciled = mountServiceTiers(ctx, entry.options.config, () => new Map([[PROVIDER, buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })]]))
  assert.equal(reconciled.current(PROVIDER, MODEL), PRIORITY)
})

it('refuses unavailable persistence and invalid Config without changing policy', async () => {
  const ctx = { fiber: { entry: { options: { id: 'provider-row' } } }, get: () => undefined, inject: () => {}, provide: () => {} } as unknown as Context
  const service = mountServiceTiers(ctx, {}, () => new Map([[PROVIDER, buildCodexProfile({ provider: PROVIDER, displayName: PROVIDER })]]))
  await assert.rejects(service.select(PROVIDER, MODEL, PRIORITY), /writable provider settings/)
  assert.equal(service.current(PROVIDER, MODEL), undefined)
  assert.throws(() => plugin.Config({ serviceTierSelections: [{ provider: PROVIDER, model: MODEL, tier: UNKNOWN }] } as never))
})

const ACCOUNT = 'tier-local-account'
const AUTH_CLAIM = 'https://api.openai.com/auth'
const ACCESS = ['header', Buffer.from(JSON.stringify({ [AUTH_CLAIM]: { chatgpt_account_id: ACCOUNT } })).toString('base64url'), 'signature'].join('.')
const GRANT = { type: 'oauth', access: ACCESS, refresh: 'tier-local-refresh', expires: Number.MAX_SAFE_INTEGER, accountId: ACCOUNT }
const RESPONSE = 'data: ' + JSON.stringify({ type: 'response.completed', response: {
  id: 'tier-local-response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
} }) + '\n\n'
const ALIAS = 'codex-tier-alias'

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
