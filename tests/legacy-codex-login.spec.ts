/** Legacy source-ID syntax must write the separate grant its configured alias actually reads. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { buildCodexProfile, recordKeyFor } from '../src/codex.ts'
import { mountLoginCommand } from '../src/login-host.ts'
import * as plugin from '../src/index.ts'
import { AGENT, COMMAND, REF, SOURCE, MemoryCredentials } from './login-host-fixture.ts'

const CODEX_SOURCE = 'openai-codex'
const CODEX_ALIAS = 'legacy-subscription-alias'
const CODEX_MODEL = 'gpt-5.4'
const ACCOUNT = 'local-codex-account'
const AUTH_CLAIM = 'https://api.openai.com/auth'
const ACCESS = ['header', Buffer.from(JSON.stringify({ [AUTH_CLAIM]: { chatgpt_account_id: ACCOUNT } })).toString('base64url'), 'signature'].join('.')
const GRANT: OAuthCredential = { type: 'oauth', access: ACCESS, refresh: 'local-codex-refresh',
  expires: Number.MAX_SAFE_INTEGER, accountId: ACCOUNT }
const RESPONSE = 'data: ' + JSON.stringify({ type: 'response.completed', response: {
  id: 'local-codex-response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
} }) + '\n\n'

for (const route of [CODEX_SOURCE, CODEX_ALIAS]) {
  test('legacy Codex login and next request share the ' + route + ' credential address', async t => {
    const ctx = new Context()
    const runtime = await ctx.plugin(LlmRuntime)
    t.after(() => runtime.dispose())
    const commands = await ctx.plugin(CommandRuntime)
    t.after(() => commands.dispose())
    const store = new MemoryCredentials()
    const credentials = await ctx.plugin((owner: Context) => owner.provide('credentials', store as never))
    t.after(() => credentials.dispose())
    const config = plugin.Config({ codexRouteId: route, codexModels: [CODEX_MODEL], codexTransport: 'sse',
      loginCommandEnabled: false } as never)
    const mounted = await ctx.plugin(plugin, config)
    t.after(() => mounted.dispose())
    const profile = buildCodexProfile({ provider: route, displayName: 'Configured Codex', models: [CODEX_MODEL], transport: 'sse' })
    const provider = profile.piProvider!
    const profiles = new Map([[route, { ...profile, piProvider: { ...provider, auth: {
      oauth: { ...provider.auth.oauth!, login: async () => GRANT },
    } } }]])
    const login = await ctx.plugin((owner: Context) => mountLoginCommand(owner, {
      loginCommandEnabled: true, loginCommandName: COMMAND, routeId: SOURCE, codexRouteId: route, apiKeyEnv: REF,
    }, { profiles: () => profiles }))
    t.after(() => login.dispose())
    const result = await ctx.commands.find(AGENT, COMMAND)!.handler({ commandId: 'legacy-codex-login', agent: AGENT,
      rawInput: CODEX_SOURCE, attachments: [], signal: new AbortController().signal } as unknown as CommandInvocation)
    assert.equal(result.kind, 'success', JSON.stringify(result))
    assert.deepEqual(store.records.get(recordKeyFor(route)), { kind: 'grant', payload: GRANT })
    assert.deepEqual(store.writes, [recordKeyFor(route)])
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests++
      const request = new Request(input, init)
      assert.equal(request.headers.get('authorization'), 'Bearer ' + ACCESS)
      assert.equal(request.headers.get('chatgpt-account-id'), ACCOUNT)
      return new Response(RESPONSE, { headers: { 'content-type': 'text/event-stream' } })
    })
    const prepared = await ctx.llm.prepareCall({ provider: route, model: CODEX_MODEL })
    // Reaching the mocked transport proves the real adapter consumed the newly stored grant.
    for await (const _chunk of prepared.stream({ ...prepared.config, messages: [] })) { /* drain auth and dispatch */ }
    assert.equal(requests, 1)
    assert.deepEqual([...store.records.keys()], [recordKeyFor(route)])
  })
}
