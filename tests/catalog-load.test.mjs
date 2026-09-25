/** Published JavaScript must preserve the exact operator-selected catalog. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as plugin from '@sagmans/dsh-provider-extra'

import { exampleConfig, GO_ALIAS, REQUEST_DEFAULT, REQUEST_OVERRIDE, DEFAULT_EFFORT } from './fixtures/example-catalog.mjs'

const PAIRS = exampleConfig().catalog.providers.map(provider => [provider.id, provider.models.map(model => model.id)])
const GO = PAIRS[2][0]
const QWEN = { provider: PAIRS[3][0], model: PAIRS[3][1][0] }
const XAI = { provider: PAIRS[4][0], model: PAIRS[4][1][0] }

test('built package serves exactly the synthetic selected pairs and one canonical default', async () => {
  const config = exampleConfig()
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, config)
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), PAIRS.map(([provider]) => provider))
    let count = 0
    for (const [provider, expected] of PAIRS) {
      const models = await ctx.llm.listModels(provider)
      assert.deepEqual(models.map(model => model.id), expected)
      for (const model of models) {
        assert.equal((await ctx.llm.resolveModelInfo(provider, model.id)).id, model.id)
        count++
      }
    }
    assert.equal(count, PAIRS.reduce((sum, [, models]) => sum + models.length, 0))
    assert.deepEqual(ctx.get('agentDefaultModel').currentSelection(), config.catalog.default)
    assert.deepEqual(plugin.compileCatalog(config.catalog).resolveSelection({
      provider: GO, model: GO_ALIAS, reasoningEffort: DEFAULT_EFFORT,
    }), config.catalog.default)
    const go = await ctx.llm.listModels(GO)
    assert.equal(go[0].name, config.catalog.providers[2].models[0].name)
    await assert.rejects(ctx.get('agentDefaultModel').saveSelection(config.catalog.default), { code: 'CONFIG_PERSISTENCE_UNAVAILABLE' })
  } finally { await mounted?.dispose(); await runtime.dispose() }
})

test('migration preserves Qwen explicit request defaults without inventing a Grok request cap', async () => {
  const config = exampleConfig()
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, config)
    const qwen = await ctx.llm.prepareCall(QWEN)
    assert.equal(qwen.config.maxTokens, REQUEST_DEFAULT)
    assert.equal(qwen.adapterDefaults.maxTokens, true)
    const grok = await ctx.llm.prepareCall(XAI)
    assert.equal(grok.config.maxTokens, undefined)
    assert.equal(grok.adapterDefaults.maxTokens, undefined)
    const explicit = await ctx.llm.prepareCall({ ...QWEN, maxTokens: REQUEST_OVERRIDE })
    assert.equal(explicit.config.maxTokens, REQUEST_OVERRIDE)
    assert.equal(explicit.adapterDefaults.maxTokens, undefined)
  } finally { await mounted?.dispose(); await runtime.dispose() }
})

test('mounted credential routing and request policy reach the local wire without a replacement resolver', async () => {
  const captured = []
  const references = []
  const session = 'catalog-wire-session'
  const server = createServer((request, response) => {
    let data = ''
    request.on('data', chunk => { data += chunk })
    request.on('end', () => {
      const body = JSON.parse(data)
      captured.push({ body, headers: request.headers })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 0, model: body.model,
        choices: [{ index: 0, delta: { content: 'local reply' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = 'http://127.0.0.1:' + server.address().port
  const config = exampleConfig()
  for (const route of config.catalog.providers) route.baseURL = endpoint
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const credentials = await ctx.plugin(owner => owner.provide('credentials', {
    async resolve(ref) { references.push(ref); return { value: 'local-' + ref } },
  }))
  let mounted
  try {
    mounted = await ctx.plugin(plugin, config)
    const selections = [
      ctx.get('agentDefaultModel').currentSelection(),
      QWEN,
      { ...QWEN, maxTokens: REQUEST_OVERRIDE },
    ]
    for (const selection of selections) {
      const prepared = await ctx.llm.prepareCall(selection)
      for await (const chunk of prepared.stream({ ...prepared.config, messages: [], sessionId: session })) {
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') assert.fail(chunk.reason.failure.message)
      }
    }
    assert.deepEqual(references, ['EXAMPLE_KEY_2', 'EXAMPLE_KEY_3', 'EXAMPLE_KEY_3'])
    assert.deepEqual(captured.map(request => request.body.model), [PAIRS[2][1][0], QWEN.model, QWEN.model])
    assert.equal(captured[0].headers['x-opencode-session'], session)
    assert.equal(captured[0].headers.authorization, 'Bearer local-EXAMPLE_KEY_2')
    assert.equal(captured[1].headers.authorization, 'Bearer local-EXAMPLE_KEY_3')
    assert.equal(captured[1].body.max_tokens ?? captured[1].body.max_completion_tokens, REQUEST_DEFAULT)
    assert.equal(captured[2].body.max_tokens ?? captured[2].body.max_completion_tokens, REQUEST_OVERRIDE)
  } finally {
    await mounted?.dispose(); await credentials.dispose(); await runtime.dispose()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('built schema rejects invalid candidate without replacing valid catalog', async () => {
  const config = exampleConfig()
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, config)
    config.catalog.default.reasoningEffort = 'not-supported'
    await assert.rejects(async () => { await mounted.update(config) })
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), PAIRS.map(([provider]) => provider))
    assert.equal(ctx.get('agentDefaultModel').currentSelection().reasoningEffort, DEFAULT_EFFORT)
  } finally { await mounted?.dispose(); await runtime.dispose() }
})
