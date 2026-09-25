/** Public topology notifications must make a changed composition visible without rewriting it. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'

const ROUTE = 'opencode-go-session'
const MODEL = 'deepseek-v4-flash'
const REF = 'CATALOG_TEST_KEY'
const KEY = 'local-test-key'
const COLLISION = 'CATALOG_OWNER_COLLISION'
const SELECTION = { provider: ROUTE, model: MODEL }
const FIRST = 'first-generation'
const SECOND = 'second-generation'
const HEADER = 'x-catalog-generation'
const catalog = (baseURL?: string) => ({
  version: 1,
  providers: [{ id: ROUTE, name: 'Go', source: 'opencode-go', auth: { apiKeyRef: REF },
    ...(baseURL === undefined ? {} : { baseURL }), headers: { [HEADER]: FIRST },
    models: [{ id: MODEL, name: 'DeepSeek' }] }],
  default: SELECTION,
})
const competing = (id = 'external', directory = false) => ({
  inject: ['llm'],
  apply(ctx: Context) {
    if (directory) ctx.llm.registerConfigurableProviders([{ provider: id, displayName: id, settingsNs: id, settingsPath: [id] }])
    else ctx.llm.registerAdapter([id], { providerInfo: () => ({ id, name: id }), providerRetryPolicy: () => undefined } as never)
  },
})

/** Draining the public prepared call proves dispatch gating without reading private adapter state. */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const chunk of stream) {
    if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code ?? 'STREAM_FAILED')
    }
  }
}

for (const directory of [false, true]) {
  test('late ' + (directory ? 'directory' : 'adapter') + ' emits one diagnostic, fails managed boundaries, and recovers on disposal', async () => {
    const ctx = new Context()
    const diagnostics: unknown[] = []
    ctx.logger.exporter({ export(message) { if (message.type === 'error') diagnostics.push(...message.args) } })
    const runtime = await ctx.plugin(LlmRuntime)
    const mounted = await ctx.plugin(plugin, { catalog: catalog() } as never)
    const defaults = ctx.get('agentDefaultModel')
    const prepared = await ctx.llm.prepareCall(SELECTION)
    let external
    let another
    try {
      external = await ctx.plugin(competing('external', directory))
      assert.equal(diagnostics.filter(item => (item as { code?: string })?.code === COLLISION).length, 1)
      assert.ok(directory ? ctx.llm.listConfigurableProviders().some(row => row.provider === 'external')
        : ctx.llm.listProviders().some(row => row.id === 'external'), 'the plugin must not filter or veto unrelated global rows')
      await assert.rejects(ctx.llm.listModels(ROUTE), { code: COLLISION })
      await assert.rejects(ctx.llm.resolveModelInfo(ROUTE, MODEL), { code: COLLISION })
      await assert.rejects(ctx.llm.prepareCall(SELECTION), { code: COLLISION })
      assert.throws(() => defaults.currentSelection(), { code: COLLISION })
      await assert.rejects(defaults.saveSelection(SELECTION), { code: COLLISION })
      await assert.rejects(drain(prepared.stream({ ...prepared.config, messages: [] })), { code: COLLISION })
      another = await ctx.plugin(competing('another', directory))
      assert.equal(diagnostics.filter(item => (item as { code?: string })?.code === COLLISION).length, 1)
      await another.dispose()
      assert.throws(() => defaults.currentSelection(), { code: COLLISION })
      await external.dispose()
      assert.deepEqual(defaults.currentSelection(), SELECTION)
      assert.deepEqual((await ctx.llm.listModels(ROUTE)).map(model => model.id), [MODEL])
      assert.equal((await ctx.llm.resolveModelInfo(ROUTE, MODEL)).id, MODEL)
      assert.deepEqual((await ctx.llm.prepareCall(SELECTION)).config.provider, ROUTE)
      assert.equal(ctx.get('agentDefaultModel'), defaults, 'recovery must not replace the valid snapshot owner')
      external = await ctx.plugin(competing('external', directory))
      assert.equal(diagnostics.filter(item => (item as { code?: string })?.code === COLLISION).length, 2)
      await external.dispose()
      assert.deepEqual(defaults.currentSelection(), SELECTION)
    } finally { await another?.dispose(); await external?.dispose(); await mounted.dispose(); await runtime.dispose() }
  })
}

test('a collision during asynchronous credential lookup fails before provider dispatch', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  let release!: () => void
  let entered!: () => void
  const lookupStarted = new Promise<void>(resolve => { entered = resolve })
  const lookup = new Promise<void>(resolve => { release = resolve })
  const credentials = await ctx.plugin((owner: Context) => owner.provide('credentials', {
    async resolve() { entered(); await lookup; return undefined },
  }))
  const mounted = await ctx.plugin(plugin, { catalog: catalog() } as never)
  let external
  try {
    const prepared = await ctx.llm.prepareCall(SELECTION)
    const dispatched = drain(prepared.stream({ ...prepared.config, messages: [] }))
    const rejected = assert.rejects(dispatched, { code: COLLISION })
    await lookupStarted
    external = await ctx.plugin(competing())
    release()
    await rejected
  } finally { release(); await external?.dispose(); await mounted.dispose(); await credentials.dispose(); await runtime.dispose() }
})

test('legitimate reload retains captured dispatch and does not interrupt an already-started request', async () => {
  const seen: string[] = []
  let requestStarted!: () => void
  const started = new Promise<void>(resolve => { requestStarted = resolve })
  let releaseResponse!: () => void
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      seen.push(String(request.headers[HEADER]))
      requestStarted()
      void responseGate.then(() => {
        const payload = JSON.parse(body) as { model: string }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 0, model: payload.model,
          choices: [{ index: 0, delta: { content: 'local reply' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const ctx = new Context()
  const diagnostics: unknown[] = []
  ctx.logger.exporter({ export(message) { if (message.type === 'error') diagnostics.push(...message.args) } })
  const runtime = await ctx.plugin(LlmRuntime)
  const credentials = await ctx.plugin((owner: Context) => owner.provide('credentials', { resolve: async () => ({ value: KEY }) }))
  const mounted = await ctx.plugin(plugin, { catalog: catalog(endpoint) } as never)
  let external
  try {
    const prepared = await ctx.llm.prepareCall(SELECTION)
    const replacement = catalog(endpoint)
    replacement.providers[0]!.headers[HEADER] = SECOND
    await mounted.update({ catalog: replacement })
    const active = drain(prepared.stream({ ...prepared.config, messages: [] }))
    await started
    external = await ctx.plugin(competing())
    releaseResponse()
    await active
    assert.deepEqual(seen, [FIRST], 'already-started dispatch retains its authorized generation')
    await external.dispose()
    const next = await ctx.llm.prepareCall(SELECTION)
    await drain(next.stream({ ...next.config, messages: [] }))
    assert.deepEqual(seen, [FIRST, SECOND])
    assert.equal(diagnostics.filter(item => (item as { code?: string })?.code === COLLISION).length, 1)
  } finally {
    releaseResponse(); await external?.dispose(); await mounted.dispose(); await credentials.dispose(); await runtime.dispose()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
