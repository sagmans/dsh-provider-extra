/**
 * Behavior of the OpenCode Go route: every model request carries the routing
 * header with the request's own session id, the configured fallback when a
 * request has none, and no header when neither exists. A mock gateway stands in
 * for the real one so the assertions read the exact bytes on the wire.
 *
 * The primary cases dispatch through prepareCall() — the path the harness
 * runtime actually drives — because that distinction is exactly where a
 * per-request mechanism can silently stop applying.
 *
 * @module dsh-provider-extra/tests
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Message, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { DEEPSEEK_V41_FLASH_ID, DEEPSEEK_V41_FLASH_NAME, OPENCODE_GO_PROVIDER_ID, SESSION_HEADER_NAME, buildOpenCodeGoProfile, openCodeGoAuth } from '../src/opencode-go.ts'
import type { OpenCodeGoRouteConfig } from '../src/opencode-go.ts'
import { Config } from '../src/index.ts'
import type { Config as ConfigShape } from '../src/index.ts'

/**
 * Resolve one raw entry document the way the loader hands it to the schema: a
 * profile patch is a partial document, so only the schema can say whether a
 * key survives into the config this plugin runs on.
 */
function resolveConfig(document: Record<string, unknown>): ConfigShape {
  return Config(document as unknown as ConfigShape)
}

/** One catalog id the installed pi-ai catalog ships, for whitelist cases. */
const CATALOG_MODEL_ID = 'deepseek-v4-flash'

/** A declared extra cloning the catalog sibling above. */
const DECLARED_EXTRA = { id: 'my-flash', template: CATALOG_MODEL_ID }

/** The served ids of one route configuration, in the order it advertises them. */
function servedIds(route: Partial<OpenCodeGoRouteConfig> = {}): string[] {
  return buildOpenCodeGoProfile({ ...baseRoute, ...route }).piProvider!.getModels().map(model => model.id)
}

/** Header sets the mock gateway received, one entry per request. */
const capturedHeaders: Array<Record<string, string | string[] | undefined>> = []

let baseRoute: OpenCodeGoRouteConfig
let modelId: string
let serverUrl: string

/** Minimal OpenAI-compatible SSE reply: one text delta, one stop, then DONE. */
function sseReply(model: string): string {
  return 'data: ' + JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
  }) + '\n\n'
    + 'data: ' + JSON.stringify({
      id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) + '\n\n'
    + 'data: [DONE]\n\n'
}

const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    capturedHeaders.push(request.headers)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const model = typeof body === 'string' && body.length > 0
      ? (JSON.parse(body).model ?? modelId)
      : modelId
    response.end(sseReply(model))
  })
})

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  serverUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1'
  const catalog = builtinProviders().find(provider => provider.id === OPENCODE_GO_PROVIDER_ID)
  assert.notEqual(catalog, undefined, 'installed pi-ai catalog ships OpenCode Go')
  const completions = catalog!.getModels().find(model => model.api === 'openai-completions')
  modelId = (completions ?? catalog!.getModels()[0]!).id
  baseRoute = {
    provider: 'opencode-go-test',
    displayName: 'OpenCode Go (test)',
    apiKeyEnv: 'OPENCODE_API_KEY_TEST',
    baseURL: serverUrl,
  }
})

after(() => { server.close() })

/** An adapter wired to the mock gateway with the given route overrides. */
function adapter(route: Partial<OpenCodeGoRouteConfig> = {}): PiAiAdapter {
  const merged: OpenCodeGoRouteConfig = { ...baseRoute, ...route }
  return new PiAiAdapter({
    profiles: () => new Map([[merged.provider, buildOpenCodeGoProfile(merged)]]),
    resolveApiKey: async () => 'test-key',
    auth: openCodeGoAuth(),
  })
}

/** A minimal user-turn request for the mock gateway. */
function request(sessionId?: string, model?: string): GenerateOptions {
  const message = {
    id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }],
  } as unknown as Message
  return {
    provider: baseRoute.provider,
    model: model ?? modelId,
    messages: [message],
    ...sessionId === undefined ? {} : { sessionId: sessionId as GenerateOptions['sessionId'] },
  }
}

/** The runtime dispatch: prepare once, then stream through the prepared call. */
async function viaRuntime(instance: PiAiAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const prepared = await instance.prepareCall(options.provider, options.model)
  const chunks: StreamChunk[] = []
  for await (const chunk of prepared.stream(options)) chunks.push(chunk)
  return chunks
}

/** Pull one chunk so a prepared dispatch reaches the wire without draining it. */
async function firstPull(iterable: AsyncIterable<StreamChunk>): Promise<void> {
  await iterable[Symbol.asyncIterator]().next()
}

/** Direct adapter dispatch, bypassing the runtime's prepareCall step. */
async function viaStream(instance: PiAiAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of instance.stream(options)) chunks.push(chunk)
  return chunks
}

/** The routing header value of the most recently captured request, or absence. */
function lastSessionHeader(): string | string[] | undefined {
  return capturedHeaders.at(-1)?.[SESSION_HEADER_NAME]
}

describe('OpenCode Go session routing header', () => {
  it('carries the live session id on the runtime (prepareCall) dispatch', async () => {
    await viaRuntime(adapter(), request('session-alpha'))
    assert.equal(lastSessionHeader(), 'session-alpha')
  })

  it('carries the live session id on the direct stream dispatch too', async () => {
    await viaStream(adapter(), request('session-alpha'))
    assert.equal(lastSessionHeader(), 'session-alpha')
  })

  it('changes with the request session id', async () => {
    const instance = adapter()
    await viaRuntime(instance, request('session-alpha'))
    await viaRuntime(instance, request('session-beta'))
    assert.equal(lastSessionHeader(), 'session-beta')
  })

  it('falls back to the configured id when the request has none', async () => {
    await viaRuntime(adapter({ fallbackSessionId: 'fallback-id' }), request())
    assert.equal(lastSessionHeader(), 'fallback-id')
  })

  it('stays absent when neither request nor config supplies an id', async () => {
    await viaRuntime(adapter(), request())
    assert.equal(lastSessionHeader(), undefined)
  })

  it('keeps interleaved prepared calls on their own session ids', async () => {
    const instance = adapter()
    const first = await instance.prepareCall(baseRoute.provider, modelId)
    const second = await instance.prepareCall(baseRoute.provider, modelId)
    // Both dispatch closures exist at once; each must send its own request's id.
    await firstPull(first.stream(request('session-one')))
    assert.equal(lastSessionHeader(), 'session-one')
    await firstPull(second.stream(request('session-two')))
    assert.equal(lastSessionHeader(), 'session-two')
  })

  it('merges configured static headers under the session header', async () => {
    await viaRuntime(adapter({ headers: { 'x-custom': 'value' } }), request('session-gamma'))
    assert.equal(lastSessionHeader(), 'session-gamma')
    assert.equal(capturedHeaders.at(-1)?.['x-custom'], 'value')
  })

  it('produces a text and finish chunk from the mock gateway', async () => {
    const chunks = await viaRuntime(adapter(), request('session-delta'))
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta'))
  })
})

describe('DeepSeek V4.1 Flash catalog entry', () => {
  it('serves deepseek-flash re-keyed to the route', () => {
    const models = buildOpenCodeGoProfile(baseRoute).piProvider!.getModels()
    const flash = models.find(model => model.id === DEEPSEEK_V41_FLASH_ID)
    assert.notEqual(flash, undefined, 'route serves DeepSeek V4.1 Flash')
    assert.equal(flash!.name, DEEPSEEK_V41_FLASH_NAME)
    assert.equal(flash!.provider, baseRoute.provider)
    assert.equal(flash!.api, 'openai-completions')
    // The mock baseURL override reaches the appended entry like every sibling.
    assert.equal(flash!.baseUrl, baseRoute.baseURL)
  })

  it('appears exactly once even when the profile rebuilds', () => {
    const models = buildOpenCodeGoProfile(baseRoute).piProvider!.getModels()
    assert.equal(models.filter(model => model.id === DEEPSEEK_V41_FLASH_ID).length, 1)
  })

  it('streams deepseek-flash through the mock gateway with the session header', async () => {
    const chunks = await viaRuntime(adapter(), request('session-v41', DEEPSEEK_V41_FLASH_ID))
    assert.equal(lastSessionHeader(), 'session-v41')
    assert.equal(chunks.at(-1)?.type, 'finish')
  })
})

describe('settings-declared extra models', () => {
  it('serves a declared model cloned from its template', () => {
    const models = buildOpenCodeGoProfile({
      ...baseRoute, extraModels: [{ id: 'my-flash', template: 'deepseek-v4-flash' }],
    }).piProvider!.getModels()
    const extra = models.find(model => model.id === 'my-flash')
    const template = models.find(model => model.id === 'deepseek-v4-flash')!
    assert.notEqual(extra, undefined, 'route serves the declared model')
    // Unnamed declarations read as their template; identity answers to the route.
    assert.equal(extra!.name, template.name)
    assert.equal(extra!.api, template.api)
    assert.equal(extra!.provider, baseRoute.provider)
    assert.equal(extra!.baseUrl, baseRoute.baseURL)
  })

  it('lets a declaration reshape the shipped default under the same id', () => {
    const models = buildOpenCodeGoProfile({
      ...baseRoute, extraModels: [{ id: DEEPSEEK_V41_FLASH_ID, name: 'Custom Flash' }],
    }).piProvider!.getModels()
    assert.equal(models.filter(model => model.id === DEEPSEEK_V41_FLASH_ID).length, 1)
    assert.equal(models.find(model => model.id === DEEPSEEK_V41_FLASH_ID)!.name, 'Custom Flash')
  })

  it('leaves a catalog-shipped id to the catalog', () => {
    const profile = buildOpenCodeGoProfile({
      ...baseRoute, extraModels: [{ id: 'deepseek-v4-flash', name: 'Renamed' }],
    })
    assert.equal(
      profile.piProvider!.getModels().find(model => model.id === 'deepseek-v4-flash')!.name,
      'DeepSeek V4 Flash',
    )
  })

  it('records an unknown template beside serviceable models', () => {
    const profile = buildOpenCodeGoProfile({
      ...baseRoute, extraModels: [{ id: 'bad-flash', template: 'no-such-model' }],
    })
    assert.ok(profile.modelErrors.has('bad-flash'), 'failure is diagnosable')
    assert.equal(profile.piProvider!.getModels().find(model => model.id === 'bad-flash'), undefined)
    // One mistyped declaration must not silence the rest of the route.
    assert.ok(profile.piProvider!.getModels().length > 20)
  })

  it('streams a declared extra through the mock gateway with the session header', async () => {
    const instance = adapter({ extraModels: [{ id: 'my-flash', template: 'deepseek-v4-flash' }] })
    const chunks = await viaRuntime(instance, request('session-extra', 'my-flash'))
    assert.equal(lastSessionHeader(), 'session-extra')
    assert.equal(chunks.at(-1)?.type, 'finish')
  })
})

describe('exact model selection', () => {
  it('distills the composition entry into the models the entry itself carries', () => {
    const resolved = resolveConfig({ extraModels: [DECLARED_EXTRA], models: [DECLARED_EXTRA.id] })
    assert.deepEqual(resolved.models, [DECLARED_EXTRA.id])
    assert.deepEqual(resolved.extraModels?.[0]?.template, CATALOG_MODEL_ID)
  })

  it('serves everything the catalog and the extras resolved when no selection is declared', () => {
    const ids = servedIds({ extraModels: [DECLARED_EXTRA] })
    assert.ok(ids.length > 20, 'the catalog stays whole')
    assert.ok(ids.includes(CATALOG_MODEL_ID))
    assert.ok(ids.includes(DEEPSEEK_V41_FLASH_ID))
    assert.ok(ids.includes(DECLARED_EXTRA.id))
  })

  it('serves only the declared ids, in the declared order', () => {
    // Reverse catalog order: the declaration, not the catalog, decides order.
    assert.deepEqual(servedIds({ models: [DEEPSEEK_V41_FLASH_ID, CATALOG_MODEL_ID] }), [DEEPSEEK_V41_FLASH_ID, CATALOG_MODEL_ID])
  })

  it('selects across the catalog, the shipped extra, and a declared extra alike', () => {
    const ids = servedIds({ models: [DECLARED_EXTRA.id, DEEPSEEK_V41_FLASH_ID, CATALOG_MODEL_ID], extraModels: [DECLARED_EXTRA] })
    assert.deepEqual(ids, [DECLARED_EXTRA.id, DEEPSEEK_V41_FLASH_ID, CATALOG_MODEL_ID])
    const chosen = buildOpenCodeGoProfile({
      ...baseRoute, models: [DECLARED_EXTRA.id], extraModels: [DECLARED_EXTRA],
    }).piProvider!.getModels()
    // A selected extra is served exactly like a selected catalog model.
    assert.equal(chosen[0]!.provider, baseRoute.provider)
    assert.equal(chosen[0]!.baseUrl, baseRoute.baseURL)
  })

  it('keeps a repeated id as one model at its first position', () => {
    assert.deepEqual(servedIds({ models: [CATALOG_MODEL_ID, CATALOG_MODEL_ID] }), [CATALOG_MODEL_ID])
  })

  it('serves nothing when the selection is declared empty', () => {
    // A composition entry never reaches this state: its schema materializes an
    // undeclared array as an empty one, and the wiring reads an empty
    // declaration as no selection at all.
    assert.deepEqual(servedIds({ models: [] }), [])
  })

  it('refuses a selected id nothing resolves, naming the route and the id', () => {
    assert.throws(
      () => buildOpenCodeGoProfile({ ...baseRoute, models: [CATALOG_MODEL_ID, 'no-such-model'] }),
      (error: unknown) => error instanceof LlmError
        && /UNKNOWN_MODEL/.test(error.code)
        && error.message.includes(baseRoute.provider)
        && error.message.includes('no-such-model'),
    )
  })

  it('refuses a selected extra whose template does not resolve', () => {
    assert.throws(
      () => buildOpenCodeGoProfile({ ...baseRoute, models: ['bad-flash'], extraModels: [{ id: 'bad-flash', template: 'no-such-model' }] }),
      (error: unknown) => error instanceof LlmError && error.message.includes('bad-flash'),
    )
  })

  it('streams a selected extra through the mock gateway with the session header', async () => {
    const instance = adapter({ models: [DECLARED_EXTRA.id], extraModels: [DECLARED_EXTRA] })
    const chunks = await viaRuntime(instance, request('session-whitelist', DECLARED_EXTRA.id))
    assert.equal(lastSessionHeader(), 'session-whitelist')
    assert.equal(chunks.at(-1)?.type, 'finish')
  })
})
