/** Managed declarations must remain authoritative without consulting a live provider. */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { getSupportedThinkingLevels, defaultProviderAuthContext, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import { compileCatalog } from '../src/catalog.ts'
import type { CatalogConfig, CatalogProvider, CatalogModel } from '../src/catalog.ts'
import { buildCatalogProfile } from '../src/catalog-routes.ts'

const SOURCES = ['openai', 'openai-codex', 'opencode-go', 'qwen-token-plan', 'xai']
const WIRE_ID = 'managed-wire-id'
const ROUTE = 'managed-route'
const NAME = 'Managed model'
const UNKNOWN = 'not-installed'
const ENDPOINT = 'https://managed.example/v1'
const GO_MODEL = 'deepseek-v4-flash'
const SESSION_HEADER = 'x-opencode-session'
const FALLBACK_SESSION = 'auxiliary-session'
const LIVE_SESSION = 'conversation-session'
const FIRST_GENERATION = 'generation-one'
const NEXT_GENERATION = 'generation-two'
const TEST_KEY = 'catalog-test-key'
const REQUEST_DEFAULT = 1024
const CODEX_TOKEN = 'test.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url') + '.test'
const captured: { headers: Headers; body: { model: string } }[] = []
let endpoint: string
let upgrades = 0

/** Loopback-only SSE exercises real delegates without contacting providers or reading credentials. */
const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    const payload = request.url?.includes('/codex/responses') ? { model: 'codex' } : JSON.parse(body)
    captured.push({ headers: new Headers(request.headers as Record<string, string>), body: payload })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (request.url?.includes('/codex/responses')) {
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: {
        id: 'local-response', status: 'completed', output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      } }) + '\n\n')
    } else response.end('data: ' + JSON.stringify({
      id: 'local-completion', object: 'chat.completion.chunk', created: 0, model: payload.model,
      choices: [{ index: 0, delta: { content: 'local reply' }, finish_reason: 'stop' }],
    }) + '\n\ndata: [DONE]\n\n')
  })
})
server.on('upgrade', (_request, socket) => {
  upgrades++
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
})
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
})
after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))

/** Installed fixtures exercise real metadata without making any provider request. */
function sourceModel(source = 'openai'): Model<Api> {
  return builtinProviders().find(provider => provider.id === source)!.getModels()[0]!
}

function provider(source = 'openai', models?: CatalogModel[]): CatalogProvider {
  const model = sourceModel(source)
  return {
    id: ROUTE, name: 'Managed provider', source,
    auth: source === 'openai-codex' ? { credentialProvider: source } : { apiKeyRef: 'MANAGED_API_KEY' },
    models: models ?? [{ id: model.id, name: NAME }],
  }
}

function config(route = provider()): CatalogConfig {
  return { version: 1, providers: [route], default: route.models.length ? { provider: route.id, model: route.models[0]!.id } : null }
}

function served(input: CatalogConfig): readonly Model<Api>[] {
  return compileCatalog(input)!.profiles.get(input.providers[0]!.id)!.piProvider!.getModels()
}

describe('managed catalog compilation', () => {
  it('keeps explicit request defaults separate from model capacity', () => {
    const route = provider()
    Object.assign(route.models[0]!, { defaultMaxTokens: REQUEST_DEFAULT })
    const profile = compileCatalog(config(route))!.profiles.get(ROUTE)!
    assert.equal(profile.configuredMaxTokens.get(route.models[0]!.id), REQUEST_DEFAULT)
    assert.equal(profile.piProvider!.getModels()[0]!.maxTokens, sourceModel().maxTokens)
    const ordinary = compileCatalog(config(provider()))!.profiles.get(ROUTE)!
    assert.equal(ordinary.configuredMaxTokens.size, 0)
  })

  it('rejects invalid explicit request defaults before publication', () => {
    for (const invalid of [null, '1024', 0, -1, 1.5, Infinity, NaN, sourceModel().maxTokens + 1]) {
      const route = provider()
      Object.assign(route.models[0]!, { defaultMaxTokens: invalid })
      assert.throws(() => compileCatalog(config(route)), /defaultMaxTokens/)
    }
  })

  it('detaches all selected facts and protects retained profile generations', () => {
    const input = config(provider('openai', [{ id: sourceModel().id, name: NAME, aliases: ['friendly'], metadata: { cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } }]))
    input.providers[0]!.headers = { 'x-generation': FIRST_GENERATION }
    const snapshot = compileCatalog(input)!
    const profile = snapshot.profiles.get(ROUTE)!
    const model = profile.piProvider!.getModels()[0]!
    input.providers[0]!.models[0]!.metadata!.cost!.input = 9
    input.providers[0]!.headers!['x-generation'] = NEXT_GENERATION
    input.providers[0]!.models[0]!.aliases!.push('later-alias')
    assert.equal(model.cost.input, 1)
    assert.equal(profile.headers!['x-generation'], FIRST_GENERATION)
    assert.throws(() => snapshot.resolveSelection({ provider: ROUTE, model: 'later-alias' }))
    for (const value of [snapshot, snapshot.config, snapshot.config.providers, snapshot.providers.get(ROUTE)!, profile, profile.piProvider!, profile.piProvider!.getModels(), model, model.cost, profile.piProvider!.auth]) {
      assert.equal(Object.isFrozen(value), true)
    }
    assert.throws(() => { model.cost.input = 8 })
    assert.throws(() => { (snapshot.profiles as Map<string, unknown>).clear() })
    snapshot.profiles.forEach((_value, _key, map) => assert.equal(map, snapshot.profiles))
    assert.equal(compileCatalog(input)!.profiles.get(ROUTE)!.piProvider!.getModels()[0]!.cost.input, 9)
  })

  for (const method of ['stream', 'streamSimple'] as const) {
    it('injects live and fallback Go routing on ' + method, async () => {
      const route = provider('opencode-go', [{ id: GO_MODEL, name: NAME, metadata: { headers: { [SESSION_HEADER.toUpperCase()]: 'stale-model' } } }])
      route.baseURL = endpoint
      route.fallbackSessionId = FALLBACK_SESSION
      route.headers = { [SESSION_HEADER.toUpperCase()]: 'stale-static', 'x-static': 'configured' }
      const profile = buildCatalogProfile(route)
      const pi = profile.piProvider!
      for (const sessionId of [LIVE_SESSION, undefined]) {
        const options = { apiKey: TEST_KEY, sessionId, headers: { [SESSION_HEADER.toUpperCase()]: 'stale-request', 'x-request': 'preserved' } }
        const response = await pi[method](pi.getModels()[0]!, { messages: [] }, options).result()
        assert.notEqual(response.stopReason, 'error', response.errorMessage)
        const request = captured.at(-1)!
        assert.equal(request.headers.get(SESSION_HEADER), sessionId ?? FALLBACK_SESSION)
        assert.equal(request.headers.get('x-static'), 'configured')
        assert.equal(request.headers.get('x-request'), 'preserved')
        assert.equal(options.headers[SESSION_HEADER.toUpperCase()], 'stale-request')
      }
    })

    it('pins Codex transport and preserves OAuth on ' + method, async () => {
      const route = { ...provider('openai-codex'), baseURL: endpoint, transport: 'sse' as const }
      const profile = buildCatalogProfile(route)
      assert.equal(profile.apiKeyEnv, undefined)
      assert.equal(typeof profile.piProvider!.auth.oauth?.login, 'function')
      const before = upgrades
      const pi = profile.piProvider!
      const response = await pi[method](pi.getModels()[0]!, { messages: [] }, {
        apiKey: CODEX_TOKEN, transport: 'websocket', maxRetries: 0, websocketConnectTimeoutMs: 100, timeoutMs: 1000,
      }).result()
      assert.notEqual(response.stopReason, 'error', response.errorMessage)
      assert.equal(upgrades, before, 'pinned SSE must not attempt a WebSocket upgrade')
      assert.equal(captured.at(-1)!.headers.get('chatgpt-account-id'), 'test-account')
    })
  }

  it('does not invent Go routing identity when session and fallback are absent', async () => {
    const profile = buildCatalogProfile({ ...provider('opencode-go', [{ id: GO_MODEL, name: NAME }]), baseURL: endpoint })
    const pi = profile.piProvider!
    const response = await pi.streamSimple(pi.getModels()[0]!, { messages: [] }, { apiKey: TEST_KEY }).result()
    assert.notEqual(response.stopReason, 'error', response.errorMessage)
    assert.equal(captured.at(-1)!.headers.get(SESSION_HEADER), null)
  })

  it('validates effort against explicitly overridden thinking metadata', () => {
    const route = provider('openai-codex')
    route.models[0]!.metadata = { thinkingLevelMap: { high: null, low: 'low' } }
    const input = config(route)
    const snapshot = compileCatalog(input)!
    assert.throws(() => snapshot.resolveSelection({ ...input.default, reasoningEffort: 'high' }))
    assert.equal(snapshot.resolveSelection({ ...input.default, reasoningEffort: 'low' }).reasoningEffort, 'low')
    assert.equal(snapshot.profiles.get(ROUTE)!.configuredMaxTokens.size, 0)
  })

  it('retains prepared adapter dispatch facts across catalog replacement', async () => {
    const route = { ...provider('opencode-go', [{ id: GO_MODEL, name: NAME }]), baseURL: endpoint,
      headers: { 'x-generation': FIRST_GENERATION }, fallbackSessionId: FALLBACK_SESSION }
    let snapshot = compileCatalog(config(route))!
    const adapter = new PiAiAdapter({ profiles: () => snapshot.profiles, resolveApiKey: async () => TEST_KEY,
      auth: { credentials: new InMemoryCredentialStore(), authContext: defaultProviderAuthContext() } })
    const prepared = await adapter.prepareCall(ROUTE, GO_MODEL)
    route.headers['x-generation'] = NEXT_GENERATION
    route.models[0]!.name = NEXT_GENERATION
    snapshot = compileCatalog(config(route))!
    const request: GenerateOptions = { provider: ROUTE, model: GO_MODEL, messages: [] }
    for await (const _chunk of prepared.stream(request)) { /* Draining proves the retained delegate reaches the loopback gateway. */ }
    assert.equal(captured.at(-1)!.headers.get('x-generation'), FIRST_GENERATION)
    assert.equal(captured.at(-1)!.headers.get(SESSION_HEADER), FALLBACK_SESSION)
    const replacement = await adapter.prepareCall(ROUTE, GO_MODEL)
    for await (const _chunk of replacement.stream(request)) { /* Both generations must remain serviceable independently. */ }
    assert.equal(captured.at(-1)!.headers.get('x-generation'), NEXT_GENERATION)
  })

  for (const source of SOURCES) {
    it('serves exactly the selected canonical model for ' + source, () => {
      const input = config(provider(source))
      const snapshot = compileCatalog(input)!
      assert.deepEqual(served(input).map(model => model.id), [input.default!.model])
      assert.equal(served(input)[0]!.name, NAME)
      assert.equal(served(input)[0]!.provider, ROUTE)
      assert.deepEqual(snapshot.selection, input.default)
      assert.deepEqual(snapshot.providers.get(ROUTE), input.providers[0])
    })
  }

  it('rejects sources outside the five managed routes without a fallback', () => {
    for (const source of ['anthropic', UNKNOWN, 'alibaba']) {
      assert.throws(() => compileCatalog(config({ ...provider(), source })), /source/)
    }
  })

  it('requires Codex OAuth and rejects transport pins other sources ignore', () => {
    assert.throws(() => compileCatalog(config({ ...provider('openai-codex'), auth: { apiKeyRef: 'OPENAI_API_KEY' } })), /auth/)
    for (const source of SOURCES.filter(source => source !== 'openai-codex')) {
      assert.throws(() => compileCatalog(config({ ...provider(source), transport: 'sse' })), /transport/)
    }
  })

  it('never expands an empty route and requires null default for zero models', () => {
    const input = config(provider('openai', []))
    assert.deepEqual(served(input), [])
    assert.equal(compileCatalog(input)!.selection, null)
    assert.throws(() => compileCatalog({ ...input, default: { provider: ROUTE, model: sourceModel().id } }))
    assert.throws(() => compileCatalog({ ...config(), default: null }))
  })

  it('canonicalizes aliases without advertising extra wire models', () => {
    const input = config(provider('openai', [{ id: sourceModel().id, name: NAME, aliases: ['friendly'] }]))
    input.default!.model = 'friendly'
    const snapshot = compileCatalog(input)!
    assert.equal(snapshot.selection!.model, sourceModel().id)
    assert.equal(snapshot.config.default!.model, sourceModel().id)
    assert.equal(snapshot.resolveSelection({ provider: ROUTE, model: 'friendly' }).model, sourceModel().id)
    assert.deepEqual(served(input).map(model => model.id), [sourceModel().id])
    assert.throws(() => snapshot.resolveSelection({ provider: ROUTE, model: UNKNOWN }))
    assert.throws(() => snapshot.resolveSelection({ provider: UNKNOWN, model: sourceModel().id }))
  })

  it('requires an explicit catalog sibling and preserves the declared wire identity', () => {
    const sibling = sourceModel('opencode-go')
    const input = config(provider('opencode-go', [{ id: WIRE_ID, name: NAME, template: sibling.id }]))
    const model = served(input)[0]!
    assert.equal(model.id, WIRE_ID)
    assert.equal(model.name, NAME)
    assert.equal(model.api, sibling.api)
    assert.equal(model.contextWindow, sibling.contextWindow)
    assert.throws(() => compileCatalog(config(provider('opencode-go', [{ id: WIRE_ID, name: NAME }]))))
    assert.throws(() => compileCatalog(config(provider('opencode-go', [{ id: WIRE_ID, name: NAME, template: UNKNOWN }]))))
  })

  it('rejects protocol changes that would inherit incompatible template metadata', () => {
    const sibling = sourceModel('opencode-go')
    assert.equal(sibling.api, 'anthropic-messages')
    const metadata = { api: 'openai-completions' }
    for (const id of [sibling.id, WIRE_ID]) {
      const model = { id, name: NAME, metadata, ...(id === sibling.id ? {} : { template: sibling.id }) }
      assert.throws(() => compileCatalog(config(provider('opencode-go', [model]))), /api/)
    }
  })

  it('honors metadata overrides for installed IDs and complete metadata for new IDs', () => {
    const metadata = {
      api: sourceModel().api, reasoning: false, input: ['text'] as ('text' | 'image')[],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
    }
    for (const id of [sourceModel().id, WIRE_ID]) {
      const model = served(config({ ...provider('openai', [{ id, name: NAME, metadata }]), baseURL: ENDPOINT }))[0]!
      assert.equal(model.id, id)
      assert.equal(model.name, NAME)
      assert.equal(model.baseUrl, ENDPOINT)
      assert.equal(model.contextWindow, 8192)
      assert.equal(model.maxTokens, 1024)
      assert.deepEqual(model.cost, metadata.cost)
    }
    for (const key of Object.keys(metadata)) {
      const incomplete = { ...metadata } as Record<string, unknown>
      delete incomplete[key]
      assert.throws(() => compileCatalog(config(provider('openai', [{ id: WIRE_ID, name: NAME, metadata: incomplete }]))), key)
    }
  })

  it('uses public thinking semantics and rejects unsupported or invalid efforts', () => {
    const input = config()
    const supported = getSupportedThinkingLevels(sourceModel())
    const snapshot = compileCatalog(input)!
    for (const reasoningEffort of supported) {
      assert.equal(snapshot.resolveSelection({ ...input.default, reasoningEffort }).reasoningEffort, reasoningEffort)
    }
    for (const reasoningEffort of ['invalid', 42, null]) {
      assert.throws(() => snapshot.resolveSelection({ ...input.default, reasoningEffort }))
      assert.throws(() => compileCatalog({ ...input, default: { ...input.default, reasoningEffort } }))
    }
    assert.throws(() => snapshot.resolveSelection({ ...input.default, reasoningEffort: 'high' }))
  })

  it('rejects malformed structure, unknown fields, duplicate IDs and ambiguous aliases', () => {
    const valid = config()
    const route = provider()
    const model = route.models[0]!
    const invalid: unknown[] = [
      null, {}, [], { ...valid, version: 2 }, { ...valid, surprise: true }, { ...valid, default: undefined },
      { ...valid, providers: {} }, { ...valid, providers: [route, route] },
      config({ ...route, id: '' }), config({ ...route, name: '' }), { ...valid, providers: [{ ...route, models: undefined }] },
      config({ ...route, auth: {} } as never), config({ ...route, auth: { apiKeyRef: 'BAD-REF' } }),
      config({ ...route, auth: { credentialProvider: 'openai-codex' } }),
      config({ ...route, auth: { apiKeyRef: 'KEY', credentialProvider: 'openai' } }),
      config({ ...route, transport: 'invalid' } as never), config({ ...route, baseURL: 'not a URL' }),
      config({ ...route, headers: { bad: 'line\nbreak' } }),
      config({ ...route, models: [model, model] }),
      config({ ...route, models: [{ ...model, name: undefined }] } as never),
      config({ ...route, models: [{ ...model, aliases: [model.id] }] }),
      config({ ...route, models: [{ ...model, aliases: ['alias', 'alias'] }] }),
      config({ ...route, models: [{ ...model, aliases: [WIRE_ID] }, { id: WIRE_ID, name: NAME, template: model.id }] }),
    ]
    for (const candidate of invalid) assert.throws(() => compileCatalog(candidate), JSON.stringify(candidate))
  })

  it('rejects malformed metadata rather than exposing a partly valid catalog', () => {
    const invalid = [
      { id: WIRE_ID }, { name: NAME }, { provider: ROUTE }, { baseUrl: ENDPOINT }, { typo: true },
      { api: UNKNOWN }, { reasoning: 'yes' }, { input: [] }, { input: ['audio'] }, { input: ['text', 'text'] },
      { contextWindow: 0 }, { contextWindow: 1.5 }, { maxTokens: -1 }, { maxTokens: Infinity },
      { cost: { input: 0 } }, { cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { thinkingLevelMap: { invalid: 'high' } }, { thinkingLevelMap: { high: false } },
      { headers: { invalid: 1 } }, { compat: { supportsStore: 'yes' } }, { compat: { unknown: true } },
      { samplingParams: {} }, { compat: { openRouterRouting: {} } }, { compat: { vercelGatewayRouting: {} } },
    ]
    for (const metadata of invalid) {
      assert.throws(() => compileCatalog(config(provider('openai', [{ id: sourceModel().id, name: NAME, metadata: metadata as never }]))), JSON.stringify(metadata))
    }
  })
  it('distinguishes absent catalog from an explicitly empty catalog', () => {
    assert.equal(compileCatalog(undefined), undefined)
    const snapshot = compileCatalog({ version: 1, providers: [], default: null })!
    assert.deepEqual(snapshot.config, { version: 1, providers: [], default: null })
    assert.equal(snapshot.profiles.size, 0)
    assert.equal(snapshot.providers.size, 0)
    assert.equal(snapshot.selection, null)
    assert.throws(() => snapshot.resolveSelection({ provider: 'missing', model: 'missing' }))
  })
})
