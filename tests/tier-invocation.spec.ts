/** Real runtime dispatch protects prepared calls from bypassing invocation policy. */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { TierSelection } from '../src/service-tiers.ts'
import { currentInvocationTier, mountTierInvocation } from '../src/tier-invocation.ts'

const PROVIDER = 'example-provider'
const MODEL = 'example-model'
const ROOT = 'example-root'
const FAST = 'fast'
const PRIORITY = 'priority'
const CLEAR = 'provider-default'
const CHILD = 'example-child'
const OTHER = 'example-other-root'
const FAILURE = 'unsupported service tier for this model route'
const FINISH: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

/** Adapter boundary records the policy that a native provider decorator would consume. */
class ObservedAdapter extends LlmAdapter {
  constructor(private readonly observed: (tier: string | null | undefined, options: GenerateOptions) => void) { super() }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.observed(currentInvocationTier(), options)
    const observed = this.observed
    return (async function* () {
      observed(currentInvocationTier(), options)
      yield FINISH
    })()
  }
}

/** This public port deliberately has no persistence writes on the invocation path. */
const tiers: TierSelection = {
  choices: () => [],
  current: () => undefined,
  select: async () => { assert.fail('invocation policy must not persist') },
  resolve: (_provider, _model, override) => {
    if (override === CLEAR) return null
    assert.equal(override, FAST)
    return PRIORITY
  },
}

it('applies one nonpersistent override to actual prepared and direct runtime streams', async () => {
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  const seen: Array<string | null | undefined> = []
  runtime.registerAdapter([PROVIDER], new ObservedAdapter(tier => seen.push(tier)))
  mountTierInvocation(ctx, tiers)
  const roots: Array<{ id: string }> = []
  ctx.providerTierInvocation.activate(FAST, undefined, { roots: () => roots })
  roots.push({ id: ROOT })
  const options = () => Object.freeze(markAgentLoopRequest({
    provider: PROVIDER, model: MODEL, messages: [], sessionId: ROOT as GenerateOptions['sessionId'],
  }))
  try {
    for await (const _chunk of runtime.stream(options())) { /* Drain the real provider boundary. */ }
    const prepared = await runtime.prepareCall({ provider: PROVIDER, model: MODEL })
    for await (const _chunk of prepared.stream(options())) { /* Prepared dispatch must share policy. */ }
    assert.deepEqual(seen, [PRIORITY, PRIORITY, PRIORITY, PRIORITY])
    assert.equal(currentInvocationTier(), undefined)
  } finally { await ctx.fiber.dispose() }
})

/** Mark exact envelopes just as the stock loop does before real runtime dispatch. */
function request(id: string | undefined, purpose?: GenerateOptions['purpose'], marked = true): GenerateOptions {
  const value: GenerateOptions = { provider: PROVIDER, model: MODEL, messages: [], purpose }
  if (id !== undefined) value.sessionId = id as GenerateOptions['sessionId']
  return Object.freeze(marked ? markAgentLoopRequest(value) : value)
}

/** Deferred adapter construction only becomes observable during consumption. */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* Await completion before checking ambient scope. */ }
}

it('validates only bound roots, not auxiliary, child, old-root or incomplete requests', async () => {
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  const seen: Array<string | null | undefined> = []
  const validated: string[] = []
  runtime.registerAdapter([PROVIDER], new ObservedAdapter(tier => seen.push(tier)))
  mountTierInvocation(ctx, { ...tiers, resolve(provider, model, override) {
    validated.push(model)
    return tiers.resolve(provider, model, override)
  } })
  const roots = [{ id: OTHER }]
  const registry = { roots: () => roots }
  try {
    await drain(runtime.stream(request(ROOT)))
    ctx.providerTierInvocation.activate(FAST, undefined, registry)
    roots.push({ id: ROOT })
    for (const options of [request(CHILD), request(OTHER), request(undefined), request(ROOT, undefined, false),
      request(ROOT, 'compaction'), request(ROOT, 'session-title')]) await drain(runtime.stream(options))
    assert.deepEqual(validated, [])
    assert.ok(seen.every(tier => tier === undefined))
    const original = request(ROOT)
    await drain(runtime.stream(original))
    assert.deepEqual(validated, [MODEL])
    assert.deepEqual(seen.slice(-2), [PRIORITY, PRIORITY])
    assert.deepEqual(Object.keys(original).sort(), ['messages', 'model', 'provider', 'purpose', 'sessionId'])
    roots.splice(1)
    await drain(runtime.stream(request(ROOT)))
    assert.deepEqual(seen.slice(-2), [undefined, undefined])
  } finally { await ctx.fiber.dispose() }
})

it('binds exact resumed roots, supports clear suppression, and forgets omitted overrides', async () => {
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  const seen: Array<string | null | undefined> = []
  runtime.registerAdapter([PROVIDER], new ObservedAdapter(tier => seen.push(tier)))
  mountTierInvocation(ctx, tiers)
  const roots: Array<{ id: string }> = []
  const registry = { roots: () => roots }
  try {
    ctx.providerTierInvocation.activate(CLEAR, ROOT, registry)
    roots.push({ id: OTHER }, { id: ROOT })
    await drain(runtime.stream(request(OTHER)))
    const prepared = await runtime.prepareCall({ provider: PROVIDER, model: MODEL })
    await drain(prepared.stream(request(ROOT)))
    assert.deepEqual(seen, [undefined, undefined, null, null])
    ctx.providerTierInvocation.activate(undefined, ROOT, registry)
    await drain(runtime.stream(request(ROOT)))
    assert.deepEqual(seen.slice(-2), [undefined, undefined])
    assert.equal(currentInvocationTier(), undefined)
  } finally { await ctx.fiber.dispose() }
})

it('rejects unsupported root routes before adapter construction, never validating auxiliary routes', async () => {
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  let constructed = 0
  runtime.registerAdapter([PROVIDER], new ObservedAdapter(() => { constructed += 1 }))
  mountTierInvocation(ctx, { ...tiers, resolve() { throw new Error(FAILURE) } })
  const roots: Array<{ id: string }> = []
  ctx.providerTierInvocation.activate(FAST, undefined, { roots: () => roots })
  roots.push({ id: ROOT })
  try {
    assert.throws(() => runtime.stream(request(ROOT)), { message: FAILURE })
    const prepared = await runtime.prepareCall({ provider: PROVIDER, model: MODEL })
    assert.throws(() => prepared.stream(request(ROOT)), { message: FAILURE })
    assert.equal(constructed, 0)
    await drain(runtime.stream(request(ROOT, 'session-title')))
    assert.equal(constructed, 2)
  } finally { await ctx.fiber.dispose() }
})

it('clears nested auxiliary and child scopes across interleaved awaits', async () => {
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  const seen: Array<[string, string | null | undefined]> = []
  const roots: Array<{ id: string }> = []
  mountTierInvocation(ctx, tiers)
  ctx.providerTierInvocation.activate(FAST, undefined, { roots: () => roots })
  roots.push({ id: ROOT })
  runtime.registerAdapter([PROVIDER], new class extends LlmAdapter {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const label = options.purpose ?? options.sessionId ?? 'missing'
      seen.push([label, currentInvocationTier()])
      return (async function* () {
        await Promise.resolve()
        if (options.sessionId === ROOT && options.purpose === undefined) {
          await Promise.all([
            drain(runtime.stream(request(ROOT, 'session-title'))),
            drain(runtime.stream(request(ROOT, 'compaction'))),
            drain(runtime.stream(request(CHILD))),
          ])
        }
        seen.push([label, currentInvocationTier()])
        yield FINISH
      })()
    }
  }())
  try {
    await drain(runtime.stream(request(ROOT)))
    assert.deepEqual(seen.filter(([label]) => label === ROOT), [[ROOT, PRIORITY], [ROOT, PRIORITY]])
    assert.equal(seen.filter(([label]) => label !== ROOT).length, 6)
    assert.ok(seen.filter(([label]) => label !== ROOT).every(([, tier]) => tier === undefined))
    assert.equal(currentInvocationTier(), undefined)
  } finally { await ctx.fiber.dispose() }
})

it('scopes iterator construction, next, return and throw without leaking into consumers', async () => {
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  const seen: Array<[string, string | null | undefined]> = []
  mountTierInvocation(ctx, tiers)
  const roots: Array<{ id: string }> = []
  ctx.providerTierInvocation.activate(FAST, undefined, { roots: () => roots })
  roots.push({ id: ROOT })
  // Public downstream middleware may construct eagerly and implement every iterator control method.
  ctx.on('llm/stream', () => {
    seen.push(['construct', currentInvocationTier()])
    return { [Symbol.asyncIterator]() {
      seen.push(['iterator', currentInvocationTier()])
      return {
        async next() { await Promise.resolve(); seen.push(['next', currentInvocationTier()]); return { done: false, value: FINISH } },
        async return() { await Promise.resolve(); seen.push(['return', currentInvocationTier()]); return { done: true as const, value: undefined } },
        async throw(error: unknown) { await Promise.resolve(); seen.push(['throw', currentInvocationTier()]); throw error },
      }
    } }
  })
  try {
    const cancelled = runtime.stream(request(ROOT))[Symbol.asyncIterator]()
    await cancelled.next()
    await cancelled.return!()
    const thrown = runtime.stream(request(ROOT))[Symbol.asyncIterator]()
    await thrown.next()
    const failure = new Error(FAILURE)
    await assert.rejects(thrown.throw!(failure), error => error === failure)
    assert.deepEqual(seen.map(([step]) => step), ['construct', 'iterator', 'next', 'return', 'construct', 'iterator', 'next', 'throw'])
    assert.ok(seen.every(([, tier]) => tier === PRIORITY))
    assert.equal(currentInvocationTier(), undefined)
  } finally { await ctx.fiber.dispose() }
})

it('isolates concurrent runtime invocations with different overrides', async () => {
  const contexts = [new Context(), new Context()]
  const seen: Array<Array<string | null | undefined>> = [[], []]
  try {
    await Promise.all(contexts.map(async (ctx, index) => {
      const runtime = new LlmRuntime(ctx)
      runtime.registerAdapter([PROVIDER], new ObservedAdapter(tier => seen[index].push(tier)))
      mountTierInvocation(ctx, tiers)
      const roots: Array<{ id: string }> = []
      ctx.providerTierInvocation.activate(index === 0 ? FAST : CLEAR, undefined, { roots: () => roots })
      roots.push({ id: ROOT })
      const prepared = await runtime.prepareCall({ provider: PROVIDER, model: MODEL })
      await drain(prepared.stream(request(ROOT)))
    }))
    assert.deepEqual(seen, [[PRIORITY, PRIORITY], [null, null]])
    assert.equal(currentInvocationTier(), undefined)
  } finally { await Promise.all(contexts.map(ctx => ctx.fiber.dispose())) }
})

it('fails closed only for ambiguous invoking roots instead of restoring a saved paid tier', async () => {
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  const oldRoot = { id: 'example-existing-root' }
  const roots = [oldRoot]
  const seen: Array<string | null | undefined> = []
  runtime.registerAdapter([PROVIDER], new ObservedAdapter(tier => seen.push(tier)))
  mountTierInvocation(ctx, tiers)
  ctx.providerTierInvocation.activate(CLEAR, undefined, { roots: () => roots })
  roots.push({ id: ROOT }, { id: OTHER })
  try {
    for (const options of [request(oldRoot.id), request(CHILD), request(ROOT, 'session-title'),
      request(OTHER, 'compaction'), request(ROOT, undefined, false), request(undefined)]) {
      await drain(runtime.stream(options))
    }
    assert.equal(seen.length, 12)
    assert.ok(seen.every(tier => tier === undefined))
    const count = seen.length
    assert.throws(() => runtime.stream(request(ROOT)), /cannot identify a unique invoking root/)
    const prepared = await runtime.prepareCall({ provider: PROVIDER, model: MODEL })
    assert.throws(() => prepared.stream(request(OTHER)), /cannot identify a unique invoking root/)
    assert.equal(seen.length, count, 'Ambiguous override must fail before provider dispatch')
    roots.pop()
    await drain(runtime.stream(request(ROOT)))
    assert.deepEqual(seen.slice(-2), [null, null], 'A unique root still honors provider-default suppression')
  } finally { await ctx.fiber.dispose() }
})
