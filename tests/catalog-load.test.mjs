/** Published JavaScript must preserve the exact operator-selected catalog. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as plugin from '@sagmans/dsh-provider-extra'

const EXAMPLE = new URL('../docs/catalog-v1.example.json', import.meta.url)
const PAIRS = [
  ['openai', ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']],
  ['openai-codex', ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']],
  ['opencode-go-session', ['deepseek-flash', 'hy4-preview', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'muse-spark-1.3-contributor', 'omen-alpha', 'space-bunny-free']],
  ['qwen-token-plan', ['qwen3.8-max', 'deepseek-v4.1-flash']],
  ['xai', ['grok-4.7']],
]

test('built package serves exactly 16 selected pairs and one canonical default', async () => {
  const config = JSON.parse(await readFile(EXAMPLE, 'utf8'))
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
    assert.equal(count, 16)
    assert.deepEqual(ctx.get('agentDefaultModel').currentSelection(), config.catalog.default)
    assert.deepEqual(plugin.compileCatalog(config.catalog).resolveSelection({
      provider: 'opencode-go-session', model: 'deepseek-v4.1-flash', reasoningEffort: 'max',
    }), config.catalog.default)
    const go = await ctx.llm.listModels('opencode-go-session')
    assert.equal(go.find(model => model.id === 'space-bunny-free').name, 'Space Bunny Free')
    await assert.rejects(ctx.get('agentDefaultModel').saveSelection(config.catalog.default), { code: 'CONFIG_PERSISTENCE_UNAVAILABLE' })
  } finally { await mounted?.dispose(); await runtime.dispose() }
})

test('migration preserves Qwen explicit request defaults without inventing a Grok request cap', async () => {
  const config = JSON.parse(await readFile(EXAMPLE, 'utf8'))
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, config)
    const qwen = await ctx.llm.prepareCall({ provider: 'qwen-token-plan', model: 'deepseek-v4.1-flash' })
    assert.equal(qwen.config.maxTokens, 384000)
    assert.equal(qwen.adapterDefaults.maxTokens, true)
    const grok = await ctx.llm.prepareCall({ provider: 'xai', model: 'grok-4.7' })
    assert.equal(grok.config.maxTokens, undefined)
    assert.equal(grok.adapterDefaults.maxTokens, undefined)
    const explicit = await ctx.llm.prepareCall({ provider: 'qwen-token-plan', model: 'deepseek-v4.1-flash', maxTokens: 2048 })
    assert.equal(explicit.config.maxTokens, 2048)
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
  const config = JSON.parse(await readFile(EXAMPLE, 'utf8'))
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
      { provider: 'qwen-token-plan', model: 'deepseek-v4.1-flash' },
      { provider: 'qwen-token-plan', model: 'deepseek-v4.1-flash', maxTokens: 2048 },
    ]
    for (const selection of selections) {
      const prepared = await ctx.llm.prepareCall(selection)
      for await (const chunk of prepared.stream({ ...prepared.config, messages: [], sessionId: session })) {
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') assert.fail(chunk.reason.failure.message)
      }
    }
    assert.deepEqual(references, ['OPENCODE_GO_API_KEY', 'QWEN_TOKEN_PLAN_API_KEY', 'QWEN_TOKEN_PLAN_API_KEY'])
    assert.deepEqual(captured.map(request => request.body.model), ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash'])
    assert.equal(captured[0].headers['x-opencode-session'], session)
    assert.equal(captured[0].headers.authorization, 'Bearer local-OPENCODE_GO_API_KEY')
    assert.equal(captured[1].headers.authorization, 'Bearer local-QWEN_TOKEN_PLAN_API_KEY')
    assert.equal(captured[1].body.max_tokens ?? captured[1].body.max_completion_tokens, 384000)
    assert.equal(captured[2].body.max_tokens ?? captured[2].body.max_completion_tokens, 2048)
  } finally {
    await mounted?.dispose(); await credentials.dispose(); await runtime.dispose()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('built schema rejects invalid candidate without replacing valid catalog', async () => {
  const config = JSON.parse(await readFile(EXAMPLE, 'utf8'))
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, config)
    config.catalog.default.reasoningEffort = 'not-supported'
    await assert.rejects(async () => { await mounted.update(config) })
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), PAIRS.map(([provider]) => provider))
    assert.equal(ctx.get('agentDefaultModel').currentSelection().reasoningEffort, 'max')
  } finally { await mounted?.dispose(); await runtime.dispose() }
})
