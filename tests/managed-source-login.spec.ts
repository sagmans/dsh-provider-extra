/** Every supported API-key source must preserve the selected storage mode. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { recordKeyFor } from '../src/codex.ts'
import { ENDPOINT, KEY, OLD_KEY, REF, SESSION, MemoryCredentials, completionResponse, mountLogin } from './login-host-fixture.ts'

const COMPLETIONS = 'openai-completions'
const RESPONSES = 'openai-responses'
/**
 * Any installed backend that offers key entry must survive the same login path.
 * The fixture stubs one endpoint, so backends that build their URL from extra
 * fields (Cloudflare account, Vertex project) stay out of this sample.
 */
const SOURCES = builtinProviders()
  .filter(provider => provider.auth?.apiKey?.login !== undefined && provider.baseUrl !== undefined
    && provider.getModels().some(model => model.api === COMPLETIONS || model.api === RESPONSES))
  .map(provider => provider.id)
const RESPONSE_ID = 'local-login-response'
const MESSAGE_ID = 'local-login-message'

/** Native Responses events keep verification on the real source delegate without HTTP access. */
function responsesResponse(model: string): Response {
  const item = { type: 'message', id: MESSAGE_ID, role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
  const response = { id: RESPONSE_ID, model, status: 'completed', output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'ok' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
  return new Response(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''),
    { headers: { 'content-type': 'text/event-stream' } })
}

for (const source of SOURCES) for (const mode of ['reference', 'record'] as const) {
  test(source + ' login verifies configured delegate and writes only its ' + mode, async t => {
    const model = builtinProviders().find(provider => provider.id === source)!.getModels()
      .find(model => model.api === COMPLETIONS || model.api === RESPONSES)!
    const route = source + '-login-test'
    const store = new MemoryCredentials()
    store.records.set(recordKeyFor(source), { kind: 'api-key', key: OLD_KEY })
    const config = { catalog: { version: 1, providers: [{ id: route, name: source, source,
      auth: mode === 'reference' ? { apiKeyRef: REF } : { credentialProvider: source },
      baseURL: ENDPOINT, ...(source === 'opencode-go' ? { fallbackSessionId: SESSION } : {}),
      models: [{ id: model.id, name: model.name }],
    }], default: { provider: route, model: model.id } } }
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests++
      const request = new Request(input, init)
      assert.equal(request.url, ENDPOINT + (model.api === COMPLETIONS ? '/chat/completions' : '/responses'))
      assert.equal(request.headers.get('authorization'), 'Bearer ' + KEY)
      assert.equal((await request.json() as { model: string }).model, model.id)
      return model.api === COMPLETIONS ? completionResponse() : responsesResponse(model.id)
    })
    const { run } = await mountLogin(t, { config, credentials: store })
    const result = await run(route + ' key')
    assert.equal(result.kind, 'success', JSON.stringify(result))
    assert.equal(requests, 1)
    assert.deepEqual(store.writes, [mode === 'reference' ? REF : recordKeyFor(source)])
    assert.equal(store.records.has(recordKeyFor(route)), false)
    if (mode === 'reference') {
      assert.equal(store.values.get(REF), KEY)
      assert.deepEqual(store.records.get(recordKeyFor(source)), { kind: 'api-key', key: OLD_KEY })
    } else {
      // Providers that also collect endpoint fields keep them beside the key, so the
      // mode contract is where the key lands, not the record's exact shape.
      const stored = store.records.get(recordKeyFor(source))
      assert.equal(stored?.kind, 'api-key')
      assert.equal(stored?.key, KEY)
    }
  })
}
