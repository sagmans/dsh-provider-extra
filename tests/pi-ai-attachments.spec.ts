/**
 * Image-bearing requests on the routes this plugin registers. The routes' one
 * adapter is constructed here, not by the generic llm-pi-ai plugin, so these
 * cases drive the real apply() composition instead of a hand-built
 * PiAiAdapter: only a test through the registered adapter can catch wiring the
 * plugin forgot.
 *
 * A request carrying a read_image result is exactly what that wiring serves:
 * a fresh user image and the replayed tool result the incident left in
 * history. The mock gateway answers every protocol the route's catalog serves,
 * and each success case asserts a stop reason rather than a finish chunk,
 * because a provider error ends the stream with the same chunk type.
 *
 * The Codex subscription route prefers its WebSocket transport and exposes no
 * profile knob to force the server-sent-events path, so this suite covers that
 * route's model catalog rather than a second mocked transport: the image
 * conversion it shares with openai-responses is exercised by the dispatch
 * cases above.
 *
 * @module dsh-provider-extra/tests
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmAdapter, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import { buildOpenCodeGoProfile } from '../src/opencode-go.ts'

const API_KEY_ENV = 'OPENCODE_API_KEY_ATTACH_TEST'
const ROUTE = 'opencode-go-attach-test'
/** Origin for parsing request paths only; the mock socket binds its own at listen time. */
const MOCK_ORIGIN = 'http://mock'
/** The subscription route the incident reported, and the exact model on it (an id the installed pi-ai catalog ships). */
const CODEX_ROUTE = 'openai-codex'
const CODEX_ROUTE_MODEL = 'gpt-6-astra'
/** One real 1x1 PNG, so the base64 asserted on the wire is an actual raster. */
const IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQkAAAAASUVORK5CYII=',
  'base64',
)
/** Where the fake store says the durable object lives on the host. */
const HOST_PATH = '/host/attachments/v1/objects/ac/acce.png'
/** Where the fake filesystem maps that host path inside the tool world. */
const WORLD_PATH = '/world/attachments/acce.png'
/** Durable id the fake store resolves; a traversal-shaped id must not. */
const IMAGE_ID = 'sha256:' + 'a'.repeat(64)

/** Protocols the route's catalog serves with an image-capable model. */
const PROTOCOLS = ['openai-completions', 'anthropic-messages', 'openai-responses'] as const
type Protocol = typeof PROTOCOLS[number]

/**
 * The route's own catalog, read once to pick one image-capable model per
 * protocol. The URL is irrelevant to the model list, so a placeholder keeps
 * this discovery free of the mock server's lifecycle.
 */
const catalogProfile = buildOpenCodeGoProfile({
  provider: ROUTE, displayName: 'Attach (test)', apiKeyEnv: API_KEY_ENV, baseURL: 'http://127.0.0.1:1/v1',
})
const CATALOG = catalogProfile.piProvider!.getModels()
const IMAGE_MODEL_BY_PROTOCOL = new Map<Protocol, string>(PROTOCOLS.map(protocol => {
  const model = CATALOG.find(candidate => candidate.api === protocol && candidate.input?.includes('image'))
  assert.notEqual(model, undefined, 'installed catalog ships an image-capable ' + protocol + ' model')
  return [protocol, model!.id]
}))
const TEXT_MODEL = CATALOG.find(candidate => candidate.api === 'openai-completions' && !candidate.input?.includes('image'))
assert.notEqual(TEXT_MODEL, undefined, 'installed catalog ships a text-only completions model')

/** One request the mock gateway received, in arrival order. */
interface CapturedRequest {
  path: string
  body: string
}

const captured: CapturedRequest[] = []
let serverUrl = ''

/** One server-sent event, the framing every provider's SSE parser reads. */
function sse(event: string, data: unknown): string {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'
}

/** OpenAI Chat Completions: one text delta, one stop, then DONE. */
function completionsReply(model: string): string {
  return 'data: ' + JSON.stringify({
    id: 'chatcmpl-attach', object: 'chat.completion.chunk', created: 0, model,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'seen' }, finish_reason: null }],
  }) + '\n\n'
    + 'data: ' + JSON.stringify({
      id: 'chatcmpl-attach', object: 'chat.completion.chunk', created: 0, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) + '\n\n'
    + 'data: [DONE]\n\n'
}

/** Anthropic Messages: message, one text block, end_turn. */
function anthropicReply(model: string): string {
  return sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_attach', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    },
  })
    + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'seen' } })
    + sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    + sse('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
    })
    + sse('message_stop', { type: 'message_stop' })
}

/** OpenAI Responses: one message item, one text delta, a completed terminal event. */
function responsesReply(model: string): string {
  return sse('response.created', {
    type: 'response.created', response: { id: 'resp_attach', object: 'response', status: 'in_progress', model, output: [] },
  })
    + sse('response.output_item.added', {
      type: 'response.output_item.added', output_index: 0,
      item: { id: 'msg_attach', type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    })
    + sse('response.output_text.delta', {
      type: 'response.output_text.delta', item_id: 'msg_attach', output_index: 0, content_index: 0, delta: 'seen',
    })
    + sse('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_attach', object: 'response', status: 'completed', model,
        output: [{
          id: 'msg_attach', type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: 'seen', annotations: [] }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    })
}

const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    // The route config overrides every model's catalog base, so the mock
    // accepts whatever path each SDK appends and ignores query strings.
    const path = new URL(request.url ?? '/', MOCK_ORIGIN).pathname
    captured.push({ path, body })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    let model = 'unknown'
    try { model = JSON.parse(body).model ?? 'unknown' } catch { /* a non-JSON body still gets a well-formed stream */ }
    response.end(path.endsWith('/messages') ? anthropicReply(model)
      : path.endsWith('/responses') ? responsesReply(model)
        : completionsReply(model))
  })
})

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  serverUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/gateway'
  process.env[API_KEY_ENV] = 'test-key'
})

after(() => {
  server.close()
  delete process.env[API_KEY_ENV]
})

/** The durable store behaviours the real provider distinguishes. */
type StoreFault = 'invalid-reference' | 'missing-object' | 'corrupt-object'

/** One store refusal, shaped like the provider's own attachment error. */
function attachmentFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** The adapters the plugin registered, plus the warnings its logger saw. */
interface MountedRoute {
  adapter: LlmAdapter
  adapters: LlmAdapter[]
  warnings: string[]
}

/**
 * Mount the plugin on a host stub that records the route's adapter. The
 * attachment and filesystem services are optional so one test can mount
 * neither, which is what a composition without the durable store looks like,
 * and the store double enforces the real provider's reference and object
 * validation so a refusal can be told apart from a missing seam.
 */
function mount(options: { attachments?: boolean; fs?: boolean; fault?: StoreFault; codex?: boolean } = {}): MountedRoute {
  const adapters: LlmAdapter[] = []
  const warnings: string[] = []
  const attachments = {
    async readImageRequest(ref: { attachmentId: string; mediaType: string }) {
      if (options.fault === 'missing-object') {
        throw attachmentFailure('ATTACHMENT_NOT_FOUND', 'no stored object for ' + ref.attachmentId)
      }
      if (options.fault === 'corrupt-object') {
        throw attachmentFailure('ATTACHMENT_CORRUPT', 'stored object does not match the reference metadata')
      }
      return {
        attachmentId: ref.attachmentId, mediaType: ref.mediaType,
        bytes: IMAGE_BYTES.byteLength, width: 1, height: 1, data: IMAGE_BYTES,
      }
    },
    imageHostPath: (ref: { attachmentId: string }) => {
      // The real provider validates the durable id before computing a path;
      // a traversal-shaped reference never reaches the host filesystem.
      if (ref.attachmentId !== IMAGE_ID) {
        throw attachmentFailure('INVALID_ATTACHMENT_REF', 'not a durable attachment id: ' + ref.attachmentId)
      }
      return HOST_PATH
    },
  }
  const fs = { processPathFromHostPath: (hostPath: string) => hostPath === HOST_PATH ? WORLD_PATH : undefined }
  const ctx = {
    llm: {
      registerAdapter: (_providers: readonly string[], adapter: LlmAdapter) => { adapters.push(adapter); return {} },
      registerConfigurableProviders: () => ({}),
    },
    logger: { info: () => {}, warn: (message: unknown) => { warnings.push(String(message)) }, error: () => {} },
    get: (name: string) => {
      if (name === 'attachments') return options.attachments === false ? undefined : attachments
      if (name === 'fs') return options.fs === false ? undefined : fs
      return undefined
    },
    inject: () => {},
  } as unknown as Context
  apply(ctx, {
    apiKeyEnv: API_KEY_ENV,
    routeId: ROUTE,
    displayName: 'Attach (test)',
    baseURL: serverUrl,
    codexEnabled: options.codex === true,
    codexRouteId: CODEX_ROUTE,
    codexDisplayName: 'OpenAI Codex',
    loginCommandEnabled: false,
    loginCommandName: 'dsh-provider-extra-login',
  })
  assert.equal(adapters.length, options.codex === true ? 2 : 1, 'each enabled route registers exactly one adapter')
  return { adapter: adapters[0]!, adapters, warnings }
}

/** A durable image reference as the attachment service publishes it. */
function imageRef(overrides: Record<string, unknown> = {}) {
  return {
    attachmentId: IMAGE_ID, mediaType: 'image/png',
    bytes: IMAGE_BYTES.byteLength, width: 1, height: 1, name: 'shot.png',
    ...overrides,
  }
}

/** One user turn carrying a durable image reference beside its text. */
function imageMessage(ref: Record<string, unknown> = imageRef()): Message {
  return {
    id: 'image-m1', role: 'user',
    content: [
      { type: 'text', text: 'inspect this render' },
      { type: 'image', attachment: ref },
    ],
    source: { kind: 'user' },
  } as unknown as Message
}

/**
 * The incident's trailing history: the model called read_image, the tool
 * result carried the durable image, and the next user turn replayed all of it.
 */
function replayedToolResultHistory(): Message[] {
  return [
    { id: 'user-ask', role: 'user', content: [{ type: 'text', text: 'read the screenshot' }], source: { kind: 'user' } },
    {
      id: 'assistant-call', role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1', name: 'read_image', arguments: '{"path":"/tmp/shot.png"}' }],
      source: { kind: 'model', provider: ROUTE, model: IMAGE_MODEL_BY_PROTOCOL.get('openai-completions')! },
    },
    {
      id: 'tool-result-1', role: 'user',
      content: [{
        type: 'tool-result', toolCallId: 'call-1',
        content: [{ type: 'text', text: 'image read' }, { type: 'image', attachment: imageRef() }],
      }],
      source: { kind: 'tool', callId: 'call-1' },
    },
    { id: 'user-next', role: 'user', content: [{ type: 'text', text: 'describe it' }], source: { kind: 'user' } },
  ] as unknown as Message[]
}

/** One dispatch through the path the runtime drives: prepare once, then stream. */
async function stream(
  adapter: LlmAdapter, model: string, messages: Message[],
): Promise<{ chunks: StreamChunk[]; requests: CapturedRequest[] }> {
  const before = captured.length
  const prepared = await adapter.prepareCall(ROUTE, model)
  const options: GenerateOptions = { provider: ROUTE, model, messages }
  const chunks: StreamChunk[] = []
  for await (const chunk of prepared.stream(options)) chunks.push(chunk)
  return { chunks, requests: captured.slice(before) }
}

/** The terminal chunk, proving the stream ended. */
function terminal(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const last = chunks.at(-1)
  assert.equal(last?.type, 'finish', 'stream ends in a finish chunk')
  return last as Extract<StreamChunk, { type: 'finish' }>
}

/** Every request body that carried the durable bytes. */
function bodiesWithImage(requests: CapturedRequest[]): CapturedRequest[] {
  const base64 = IMAGE_BYTES.toString('base64')
  return requests.filter(request => request.body.includes(base64))
}

/**
 * Run a request that must be refused. A provider-side refusal surfaces either
 * as a terminal error chunk or as a throw, and both must leave the mock
 * gateway untouched: a refusal that reached the wire would have leaked the
 * message it was meant to protect.
 */
async function refusal(
  adapter: LlmAdapter, model: string, messages: Message[],
): Promise<{ code: string | undefined; message: string }> {
  const before = captured.length
  let code: string | undefined
  let message = ''
  try {
    const { chunks } = await stream(adapter, model, messages)
    const reason = terminal(chunks).reason as { kind: string; failure?: { code?: string; message?: string } }
    assert.equal(reason.kind, 'error', 'the request is refused rather than answered')
    code = reason.failure?.code
    message = reason.failure?.message ?? ''
  } catch (error) {
    const failure = error as { code?: string; message?: string }
    code = failure.code
    message = String(failure.message ?? error)
  }
  assert.equal(captured.length, before, 'refusal happens before transport')
  return { code, message }
}

describe('durable image attachments on the registered route', () => {
  for (const protocol of PROTOCOLS) {
    it('carries the image to the wire on ' + protocol, async () => {
      const { adapter } = mount()
      const model = IMAGE_MODEL_BY_PROTOCOL.get(protocol)!
      const { chunks, requests } = await stream(adapter, model, [imageMessage()])
      assert.equal(terminal(chunks).reason.kind, 'stop', 'the turn succeeds, not merely finishes: ' + JSON.stringify(terminal(chunks).reason))
      assert.equal(requests.length, 1, 'one request reaches the gateway')
      assert.equal(bodiesWithImage(requests).length, 1, 'that request carries the attachment bytes')
    })
  }

  it('replays a read_image tool result from history and finishes the next turn', async () => {
    const { adapter } = mount()
    const model = IMAGE_MODEL_BY_PROTOCOL.get('openai-completions')!
    const { chunks, requests } = await stream(adapter, model, replayedToolResultHistory())
    assert.equal(terminal(chunks).reason.kind, 'stop', 'the replayed history does not refuse the turn')
    assert.equal(bodiesWithImage(requests).length, 1, 'the replayed tool result still carries its image')
  })

  it('names the normalized host copy mapped into the tool world', async () => {
    const { adapter } = mount({ fs: true })
    const model = IMAGE_MODEL_BY_PROTOCOL.get('openai-completions')!
    const { requests } = await stream(adapter, model, [imageMessage()])
    assert.ok(requests[0]!.body.includes(WORLD_PATH), 'handle text names the mapped read-only copy')
  })

  it('still sends the image when the composition mounts no filesystem service', async () => {
    const { adapter } = mount({ fs: false })
    const model = IMAGE_MODEL_BY_PROTOCOL.get('openai-completions')!
    const { chunks, requests } = await stream(adapter, model, [imageMessage()])
    assert.equal(terminal(chunks).reason.kind, 'stop')
    assert.equal(bodiesWithImage(requests).length, 1, 'the mapping is optional, the image is not')
    assert.ok(!requests[0]!.body.includes(WORLD_PATH), 'no execution-world path exists to name')
  })

  it('refuses a traversal-shaped reference before transport', async () => {
    const { adapter } = mount()
    const model = IMAGE_MODEL_BY_PROTOCOL.get('openai-completions')!
    const refused = await refusal(adapter, model, [imageMessage(imageRef({ attachmentId: '../../outside' }))])
    assert.equal(refused.code, 'INVALID_ATTACHMENT_REF')
  })

  it('refuses a missing stored object before transport', async () => {
    const { adapter } = mount({ fault: 'missing-object' })
    const model = IMAGE_MODEL_BY_PROTOCOL.get('openai-completions')!
    const refused = await refusal(adapter, model, [imageMessage()])
    assert.equal(refused.code, 'ATTACHMENT_NOT_FOUND')
  })

  it('refuses stored metadata that contradicts the object before transport', async () => {
    const { adapter } = mount({ fault: 'corrupt-object' })
    const model = IMAGE_MODEL_BY_PROTOCOL.get('openai-completions')!
    const refused = await refusal(adapter, model, [imageMessage()])
    assert.equal(refused.code, 'ATTACHMENT_CORRUPT')
  })

  it('refuses the request when the composition mounts no attachment service', async () => {
    const { adapter } = mount({ attachments: false })
    const model = IMAGE_MODEL_BY_PROTOCOL.get('openai-completions')!
    const refused = await refusal(adapter, model, [imageMessage()])
    assert.equal(refused.code, 'UNSUPPORTED_CONTENT')
  })

  it('substitutes a placeholder for a text-only model without refusing the turn', async () => {
    const { adapter } = mount()
    // Placeholder substitution is the runtime's policy, so this one case drives
    // the runtime: an adapter alone must refuse bytes its model cannot accept,
    // and only the runtime may degrade the occurrence to text instead.
    const runtime = new LlmRuntime(new Context())
    runtime.registerAdapter([ROUTE], adapter)
    const before = captured.length
    const chunks: StreamChunk[] = []
    for await (const chunk of runtime.stream({ provider: ROUTE, model: TEXT_MODEL!.id, messages: [imageMessage()] })) chunks.push(chunk)
    assert.equal(terminal(chunks).reason.kind, 'stop')
    const requests = captured.slice(before)
    assert.equal(requests.length, 1)
    assert.equal(bodiesWithImage(requests).length, 0, 'a text-only model receives no image bytes')
    assert.ok(requests[0]!.body.includes('image omitted'), 'the occurrence reaches the model as placeholder text')
  })
})

describe('replay-state diagnostics on the registered route', () => {
  it('warns when stored replay state degrades to provider-neutral conversion', async () => {
    const { adapter, warnings } = mount()
    const model = IMAGE_MODEL_BY_PROTOCOL.get('openai-completions')!
    const assistant = {
      id: 'assistant-m1', role: 'assistant',
      content: [{ type: 'text', text: 'prior answer' }],
      // A version the installed pi-ai adapter cannot replay: conversion degrades
      // instead of failing, and the plugin's logger is the only proof it happened.
      source: { kind: 'model', provider: ROUTE, model, replayState: { response: { kind: 'pi-ai', version: 999 } } },
    } as unknown as Message
    const user = { id: 'user-m2', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } } as unknown as Message
    await stream(adapter, model, [imageMessage(), assistant, user])
    assert.ok(warnings.some(warning => warning.includes('unusable replay state')), 'degrade is observable')
  })
})

describe('the Codex subscription route', () => {
  it('keeps the incident model image-capable on its own route', async () => {
    const { adapters } = mount({ codex: true })
    const runtime = new LlmRuntime(new Context())
    runtime.registerAdapter([CODEX_ROUTE], adapters.at(-1)!)
    const models = await runtime.listModels(CODEX_ROUTE)
    const reported = models.find(model => model.id === CODEX_ROUTE_MODEL)
    assert.notEqual(reported, undefined, 're-keying preserves every catalog model')
    assert.ok(reported!.inputModalities?.includes('image'), 'the model that failed still accepts images')
  })
})
