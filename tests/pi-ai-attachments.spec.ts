/**
 * Image-bearing requests on the routes this plugin registers. The routes' one
 * adapter is constructed here, not by the generic llm-pi-ai plugin, so these
 * cases drive the real apply() composition instead of a hand-built
 * PiAiAdapter: only a test through the registered adapter can catch wiring the
 * plugin forgot, and a request carrying a read_image result is exactly what
 * that wiring serves.
 *
 * @module dsh-provider-extra/tests
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmAdapter, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import { buildOpenCodeGoProfile } from '../src/opencode-go.ts'

const API_KEY_ENV = 'OPENCODE_API_KEY_ATTACH_TEST'
const ROUTE = 'opencode-go-attach-test'
/** Bytes standing in for one normalized image; the wire assertion reads their base64. */
const IMAGE_BYTES = Buffer.from('fake-png-payload')
/** Where the fake store says the durable object lives on the host. */
const HOST_PATH = '/host/attachments/v1/objects/ac/acce.png'
/** Where the fake filesystem maps that host path inside the tool world. */
const WORLD_PATH = '/world/attachments/acce.png'

const capturedBodies: string[] = []
let modelId = ''
let serverUrl = ''

/** Minimal OpenAI-compatible SSE reply: one text delta, one stop, then DONE. */
function sseReply(model: string): string {
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

const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    capturedBodies.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(sseReply(body.length > 0 ? (JSON.parse(body).model ?? 'unknown') : 'unknown'))
  })
})

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  serverUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1'
  const profile = buildOpenCodeGoProfile({ provider: ROUTE, displayName: 'Attach (test)', apiKeyEnv: API_KEY_ENV, baseURL: serverUrl })
  const model = profile.piProvider!.getModels().find(candidate => (
    candidate.api === 'openai-completions' && candidate.input?.includes('image')
  ))
  assert.notEqual(model, undefined, 'installed catalog ships an image-capable completions model')
  modelId = model!.id
  process.env[API_KEY_ENV] = 'test-key'
})

after(() => {
  server.close()
  delete process.env[API_KEY_ENV]
})

/** The adapter the plugin registered, plus the warnings its logger saw. */
interface MountedRoute {
  adapter: LlmAdapter
  warnings: string[]
}

/**
 * Mount the plugin on a host stub that records the route's adapter. The
 * attachment and filesystem services are optional so one test can mount
 * neither, which is what a composition without the durable store looks like.
 */
function mount(services: { attachments?: boolean; fs?: boolean } = {}): MountedRoute {
  const adapters: LlmAdapter[] = []
  const warnings: string[] = []
  const attachments = {
    async readImageRequest(ref: { attachmentId: string; mediaType: string }) {
      return {
        attachmentId: ref.attachmentId, mediaType: ref.mediaType,
        bytes: IMAGE_BYTES.byteLength, width: 2, height: 3, data: IMAGE_BYTES,
      }
    },
    imageHostPath: () => HOST_PATH,
  }
  const fs = { processPathFromHostPath: (hostPath: string) => hostPath === HOST_PATH ? WORLD_PATH : undefined }
  const ctx = {
    llm: {
      registerAdapter: (_providers: readonly string[], adapter: LlmAdapter) => { adapters.push(adapter); return {} },
      registerConfigurableProviders: () => ({}),
    },
    logger: { info: () => {}, warn: (message: unknown) => { warnings.push(String(message)) }, error: () => {} },
    get: (name: string) => {
      if (name === 'attachments') return services.attachments === false ? undefined : attachments
      if (name === 'fs') return services.fs === false ? undefined : fs
      return undefined
    },
    inject: () => {},
  } as unknown as Context
  apply(ctx, {
    apiKeyEnv: API_KEY_ENV,
    routeId: ROUTE,
    displayName: 'Attach (test)',
    baseURL: serverUrl,
    codexEnabled: false,
    codexRouteId: 'openai-codex',
    codexDisplayName: 'OpenAI Codex',
    loginCommandEnabled: false,
    loginCommandName: 'dsh-provider-extra-login',
  })
  assert.equal(adapters.length, 1, 'the OpenCode Go route registers exactly one adapter')
  return { adapter: adapters[0]!, warnings }
}

/** One user turn carrying a durable image reference beside its text. */
function imageMessage(): Message {
  return {
    id: 'image-m1', role: 'user',
    content: [
      { type: 'text', text: 'inspect this render' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png',
          bytes: IMAGE_BYTES.byteLength, width: 2, height: 3, name: 'shot.png',
        },
      },
    ],
  } as unknown as Message
}

/** Dispatch one request exactly as the runtime does: prepare once, then stream. */
async function streamOnce(adapter: LlmAdapter, messages: Message[]): Promise<StreamChunk[]> {
  const prepared = await adapter.prepareCall(ROUTE, modelId)
  const options: GenerateOptions = { provider: ROUTE, model: modelId, messages }
  const chunks: StreamChunk[] = []
  for await (const chunk of prepared.stream(options)) chunks.push(chunk)
  return chunks
}

/** The body the mock gateway most recently received. */
function lastBody(): string {
  return capturedBodies.at(-1) ?? ''
}

describe('durable image attachments on the registered route', () => {
  it('carries the image to the wire instead of refusing the request', async () => {
    const { adapter } = mount()
    const chunks = await streamOnce(adapter, [imageMessage()])
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.ok(lastBody().includes(IMAGE_BYTES.toString('base64')), 'request carries the attachment bytes')
  })

  it('names the normalized host copy mapped into the tool world', async () => {
    const { adapter } = mount({ fs: true })
    await streamOnce(adapter, [imageMessage()])
    assert.ok(lastBody().includes(WORLD_PATH), 'handle text names the mapped read-only copy')
  })

  it('refuses the request when the composition mounts no attachment service', async () => {
    const { adapter } = mount({ attachments: false })
    await assert.rejects(
      () => streamOnce(adapter, [imageMessage()]),
      (error: unknown) => (error as { code?: string }).code === 'UNSUPPORTED_CONTENT',
    )
  })
})

describe('replay-state diagnostics on the registered route', () => {
  it('warns when stored replay state degrades to provider-neutral conversion', async () => {
    const { adapter, warnings } = mount()
    const assistant = {
      id: 'assistant-m1', role: 'assistant',
      content: [{ type: 'text', text: 'prior answer' }],
      // A version the installed pi-ai adapter cannot replay: conversion degrades
      // instead of failing, and the plugin's logger is the only proof it happened.
      source: { kind: 'model', provider: ROUTE, model: modelId, replayState: { response: { kind: 'pi-ai', version: 999 } } },
    } as unknown as Message
    const user = { id: 'user-m2', role: 'user', content: [{ type: 'text', text: 'continue' }] } as unknown as Message
    await streamOnce(adapter, [imageMessage(), assistant, user])
    assert.ok(warnings.some(warning => warning.includes('unusable replay state')), 'degrade is observable')
  })
})
