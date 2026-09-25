/** Subscription auth must not cross a topology change while awaiting its shared grant. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { recordKeyFor } from '../src/codex.ts'
import type { CodexCredentialService } from '../src/codex.ts'
import * as plugin from '../src/index.ts'

const SOURCE = 'openai-codex'
const ROUTE = 'subscription-alias'
const MODEL = 'gpt-5.4'
const MODEL_NAME = 'Codex model'
const RELOADED_MODEL_NAME = 'Reloaded Codex model'
const ACCOUNT = 'local-account'
const REFRESH_TOKEN = 'local-refresh-token'
const ROTATED_REFRESH_TOKEN = 'local-rotated-refresh-token'
const AUTH_CLAIM = 'https://api.openai.com/auth'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const BASE_URL = 'http://127.0.0.1:1'
const MODEL_URL = BASE_URL + '/codex/responses'
const NORMALIZED_ERROR = 'PI_AI_ERROR'
const EMPTY_RESPONSE = 'EMPTY_RESPONSE'
const RESPONSE_BODY = 'data: ' + JSON.stringify({ type: 'response.completed', response: {
  id: 'local-response', status: 'completed', output: [],
  usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
} }) + '\n\n'
const COLLISION = 'CATALOG_OWNER_COLLISION'
const SELECTION = { provider: ROUTE, model: MODEL }
const ACCESS_TOKEN = ['header', Buffer.from(JSON.stringify({ [AUTH_CLAIM]: { chatgpt_account_id: ACCOUNT } })).toString('base64url'), 'signature'].join('.')
const VALID_FOR_SECONDS = 3600
const MILLISECONDS_PER_SECOND = 1000
const EXPIRED: CredentialRecord = { kind: 'grant', payload: {
  type: 'oauth', access: ACCESS_TOKEN, refresh: REFRESH_TOKEN, expires: 0, accountId: ACCOUNT,
} }
const STAGES = ['read', 'modify-lock', 'refresh', 'modify-completion'] as const
const TOPOLOGIES = ['collision', 'reload'] as const

for (const stage of STAGES) for (const topology of TOPOLOGIES) {
  test('mounted Codex handles ' + topology + ' during ' + stage, async (t) => {
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const fresh: CredentialRecord = { kind: 'grant', payload: {
      type: 'oauth', access: ACCESS_TOKEN, refresh: REFRESH_TOKEN,
      expires: Date.now() + VALID_FOR_SECONDS * MILLISECONDS_PER_SECOND, accountId: ACCOUNT,
    } }
    const requests: string[] = []
    let commits = 0
    let persisted: CredentialRecord | undefined
    // Only the transport is replaced: pi-ai's real OAuth refresh and store updater still execute.
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      requests.push(url)
      if (url !== TOKEN_URL) {
        assert.equal(url, MODEL_URL)
        assert.equal(topology, 'reload', 'conflicted OAuth must never reach model dispatch')
        return new Response(RESPONSE_BODY, { headers: { 'content-type': 'text/event-stream' } })
      }
      assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), REFRESH_TOKEN)
      assert.equal(stage, 'refresh')
      entered(); await gate
      return Response.json({ access_token: ACCESS_TOKEN, refresh_token: ROTATED_REFRESH_TOKEN, expires_in: VALID_FOR_SECONDS })
    })
    const store: CodexCredentialService = {
      async readRecord(key) {
        assert.equal(key, recordKeyFor(SOURCE), 'route aliases must not create a second OAuth grant')
        if (stage === 'read') { entered(); await gate; return undefined }
        return EXPIRED
      },
      async modifyRecord(key, change) {
        assert.equal(key, recordKeyFor(SOURCE))
        if (stage === 'modify-lock') { entered(); await gate }
        const current = stage === 'refresh' ? EXPIRED : fresh
        persisted = await change(current) ?? current
        commits++
        if (stage === 'modify-completion') { entered(); await gate }
        return persisted
      },
      async deleteRecord() { assert.fail('request auth must not delete the shared grant') },
      async listRecords() { return [] },
    }
    const ctx = new Context()
    const runtime = await ctx.plugin(LlmRuntime)
    const credentials = await ctx.plugin((owner: Context) => owner.provide('credentials', store))
    const config = { catalog: { version: 1,
      providers: [{ id: ROUTE, name: 'Codex', source: SOURCE, auth: { credentialProvider: SOURCE },
        baseURL: BASE_URL, transport: 'sse', models: [{ id: MODEL, name: MODEL_NAME }] }], default: SELECTION,
    } }
    const mounted = await ctx.plugin(plugin, config as never)
    let external
    try {
      const prepared = await ctx.llm.prepareCall(SELECTION)
      const result = (async (): Promise<LlmFailure> => {
        for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) {
          if (chunk.type === 'finish' && chunk.reason.kind === 'error') return chunk.reason.failure
        }
        throw new Error('expected a structured request failure')
      })()
      await Promise.race([waiting, result.then(() => { throw new Error('auth finished before the delayed boundary') })])
      if (topology === 'collision') {
        external = await ctx.plugin({ inject: ['llm'], apply(owner: Context) {
          owner.llm.registerAdapter(['external'], {
            providerInfo: () => ({ id: 'external', name: 'External' }), providerRetryPolicy: () => undefined,
          } as never)
        } })
      } else {
        // A changed Config forces replacement, not a no-op update of the same generation.
        const defaults = ctx.get('agentDefaultModel')
        const candidate = structuredClone(config)
        candidate.catalog.providers[0]!.models[0]!.name = RELOADED_MODEL_NAME
        await mounted.update(candidate)
        assert.notEqual(ctx.get('agentDefaultModel'), defaults)
        assert.equal((await ctx.llm.resolveModelInfo(ROUTE, MODEL)).name, RELOADED_MODEL_NAME)
      }
      release()
      const failure = await result
      const expectedCommits = stage === 'read' || (topology === 'collision' && stage === 'modify-lock') ? 0 : 1
      assert.equal(commits, expectedCommits, 'only a collision before updater entry may prevent its commit')
      assert.deepEqual(requests, [
        ...(stage === 'refresh' ? [TOKEN_URL] : []),
        ...(topology === 'reload' && stage !== 'read' ? [MODEL_URL] : []),
      ])
      if (stage === 'refresh') {
        assert.equal(persisted?.kind, 'grant')
        assert.equal((persisted?.payload as { refresh: string }).refresh, ROTATED_REFRESH_TOKEN)
      }
      if (topology === 'collision') {
        assert.equal(failure.code, NORMALIZED_ERROR)
        assert.ok(failure.message.includes(COLLISION), failure.message)
      } else if (stage === 'read') assert.match(failure.message, /Provider is not configured:/)
      else assert.equal(failure.code, EMPTY_RESPONSE, 'legitimate reload must reach the mocked model endpoint')
      await external?.dispose()
      assert.deepEqual(ctx.get('agentDefaultModel').currentSelection(), SELECTION)
    } finally { release(); await external?.dispose(); await mounted.dispose(); await credentials.dispose(); await runtime.dispose() }
  })
}
