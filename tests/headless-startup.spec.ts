/** Startup service publication is the stock runner's only activation boundary. */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as startup from '../src/headless-startup.ts'
import { currentInvocationTier, mountTierInvocation } from '../src/tier-invocation.ts'
import LlmRuntime, { LlmAdapter, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const INVALID = 'not-a-tier'
const TASK = 'example task'
const SESSION = 'example-session'
const PROVIDER = 'example-provider'
const MODEL = 'example-model'
const REPLACEMENT = 'example-replacement-session'
const FAST = 'fast'
const CLEAR = 'provider-default'
const PRIORITY = 'priority'

it('rejects invalid tiers before the stock runner can observe headlessStartup', async t => {
  const ctx = new Context()
  const exits: number[] = []
  let output = ''
  t.mock.method(process.stdout, 'write', (text: string) => { output += text; return true })
  ctx.provide('cmdlineArgs', { get: () => ['--json', '--service-tier', INVALID, TASK] })
  ctx.provide('appExit', (code: number) => { exits.push(code) })
  ctx.provide('agents', { roots: () => [] })
  mountTierInvocation(ctx, {
    choices: () => [], current: () => undefined,
    resolve: () => { assert.fail('invalid syntax must fail before resolving a route') },
    select: async () => { assert.fail('startup must not persist') },
  })
  try {
    startup.apply(ctx)
    assert.deepEqual(exits, [1])
    assert.equal(ctx.get('headlessStartup'), undefined)
    assert.deepEqual(JSON.parse(output), { type: 'error', message: 'unsupported --service-tier: not-a-tier' })
  } finally { await ctx.fiber.dispose() }
})

it('preserves task, stdin, json, resume and separator grammar without activating help', async t => {
  let output = ''
  let diagnostic = ''
  t.mock.method(process.stdout, 'write', (text: string) => { output += text; return true })
  t.mock.method(process.stderr, 'write', (text: string) => { diagnostic += text; return true })
  const cases = [
    { args: ['example', 'task'], task: TASK, sessionId: undefined, json: false },
    { args: ['--json', '--session-id', SESSION, TASK], task: TASK, sessionId: SESSION, json: true },
    { args: ['--session-id=--json', TASK], task: TASK, sessionId: '--json', json: false },
    { args: ['--session-id', '--json', TASK], task: TASK, sessionId: '--json', json: false },
    { args: ['--', '--json', '--service-tier', 'invalid'], task: '--json --service-tier invalid', sessionId: undefined, json: false },
    { args: ['-'], task: '-', sessionId: undefined, json: false },
    { args: [], task: undefined, sessionId: undefined, json: false },
  ]
  for (const sample of cases) {
    const ctx = new Context()
    const exits: number[] = []
    const activations: unknown[][] = []
    ctx.provide('cmdlineArgs', { get: () => sample.args })
    ctx.provide('appExit', (code: number) => { exits.push(code) })
    const agents = { roots: () => [] }
    ctx.provide('agents', agents)
    ctx.provide('providerTierInvocation', { activate(...args: unknown[]) { activations.push(args); return () => {} } })
    try {
      startup.apply(ctx)
      assert.deepEqual(exits, [], sample.args.join(' '))
      assert.deepEqual(ctx.get('headlessStartup'), { task: sample.task, sessionId: sample.sessionId, json: sample.json })
      assert.deepEqual(activations, [[undefined, sample.sessionId, agents]])
      assert.equal(output, '')
      assert.equal(diagnostic, '')
    } finally { await ctx.fiber.dispose() }
  }
  for (const flag of ['--help', '-h']) {
    const ctx = new Context()
    const exits: number[] = []
    ctx.provide('cmdlineArgs', { get: () => [flag] })
    ctx.provide('appExit', (code: number) => { exits.push(code) })
    try {
      startup.apply(ctx)
      assert.deepEqual(exits, [0])
      assert.equal(ctx.get('headlessStartup'), undefined)
      assert.match(output, /--service-tier/)
    } finally { await ctx.fiber.dispose() }
  }
})

it('rejects usage errors with one launcher exit and correctly framed diagnostics', async t => {
  let output = ''
  let diagnostic = ''
  t.mock.method(process.stdout, 'write', (text: string) => { output += text; return true })
  t.mock.method(process.stderr, 'write', (text: string) => { diagnostic += text; return true })
  const cases = [
    { args: ['--json', '--unknown'], json: true },
    { args: ['--service-tier'], json: false },
    { args: ['--session-id'], json: false },
    { args: ['--json', '--session-id', ' ', TASK], json: true },
    { args: ['--json', '-', TASK], json: true },
    { args: ['--json', ' '], json: true },
    { args: ['--service-tier', '--json', TASK], json: false },
    { args: ['--service-tier=invalid', '--', '--json'], json: false },
  ]
  for (const sample of cases) {
    output = ''
    diagnostic = ''
    const ctx = new Context()
    const exits: number[] = []
    ctx.provide('cmdlineArgs', { get: () => sample.args })
    ctx.provide('appExit', (code: number) => { exits.push(code) })
    try {
      startup.apply(ctx)
      assert.deepEqual(exits, [1], sample.args.join(' '))
      assert.equal(ctx.get('headlessStartup'), undefined)
      if (sample.json) {
        const record = JSON.parse(output)
        assert.equal(record.type, 'error')
        assert.ok(record.message.length > 0)
        assert.equal(diagnostic, '')
      } else {
        assert.equal(output, '')
        assert.match(diagnostic, /^error: /)
      }
    } finally { await ctx.fiber.dispose() }
  }
})

it('releases startup-owned overrides on disposal without clearing a newer startup activation', async () => {
  const provider = new Context()
  const runtime = new LlmRuntime(provider)
  const roots: Array<{ id: string }> = []
  const agents = { roots: () => roots }
  const seen: Array<string | null | undefined> = []
  const startups: Context[] = []
  mountTierInvocation(provider, {
    choices: () => [], current: () => undefined,
    resolve: (_provider, _model, override) => override === CLEAR ? null : PRIORITY,
    select: async () => { assert.fail('startup lifecycle must not persist') },
  })
  runtime.registerAdapter([PROVIDER], new class extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      seen.push(currentInvocationTier())
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }())

  /** Startup and provider contexts have independent real Cordis lifetimes. */
  function launch(override?: string): Context {
    const ctx = new Context()
    startups.push(ctx)
    ctx.provide('cmdlineArgs', { get: () => override === undefined ? [TASK] : ['--service-tier', override, TASK] })
    ctx.provide('appExit', () => { assert.fail('valid startup must not exit') })
    ctx.provide('agents', agents)
    ctx.provide('providerTierInvocation', provider.providerTierInvocation)
    startup.apply(ctx)
    assert.ok(ctx.get('headlessStartup'))
    return ctx
  }

  /** The real runtime resolves policy only when its marked invoking root is dispatched. */
  async function dispatch(id: string): Promise<void> {
    const request = Object.freeze(markAgentLoopRequest({
      provider: PROVIDER, model: MODEL, messages: [], sessionId: id as GenerateOptions['sessionId'],
    }))
    for await (const _chunk of runtime.stream(request)) { /* Drain the provider boundary before checking policy. */ }
  }

  try {
    const abandoned = launch(FAST)
    await abandoned.fiber.dispose()
    roots.push({ id: SESSION })
    await dispatch(SESSION)
    assert.deepEqual(seen, [undefined], 'Disposed unbound startup must not capture a later root')

    const noFlag = launch()
    roots.push({ id: REPLACEMENT })
    await dispatch(REPLACEMENT)
    assert.deepEqual(seen, [undefined, undefined], 'No-flag replacement must not inherit an override')
    await noFlag.fiber.dispose()

    const older = launch(FAST)
    const newer = launch(CLEAR)
    roots.splice(0, roots.length, { id: SESSION })
    await older.fiber.dispose()
    await dispatch(SESSION)
    assert.deepEqual(seen, [undefined, undefined, null], 'Old cleanup must not clear newer activation')
    await newer.fiber.dispose()
    await dispatch(SESSION)
    assert.deepEqual(seen, [undefined, undefined, null, undefined], 'Disposed bound startup must release policy')
  } finally {
    await Promise.all(startups.map(ctx => ctx.fiber.dispose()))
    await provider.fiber.dispose()
  }
})
