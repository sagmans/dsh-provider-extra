/** Mounted command fixtures keep credentials and transport entirely in memory. */
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { LoginCommandHost } from '../src/login-contract.ts'
import * as plugin from '../src/index.ts'

export const ROUTE = 'go-alias'
export const SOURCE = 'opencode-go'
export const MODEL = 'deepseek-v4-flash'
export const REF = 'MANAGED_LOGIN_TEST_KEY'
export const KEY = 'local-new-test-key'
export const OLD_KEY = 'local-old-test-key'
export const ENDPOINT = 'http://127.0.0.1:1/configured'
export const SESSION = 'login-test-session'
export const COMMAND = 'dsh-provider-extra-login'
export const AGENT = { id: 'local-login-agent' } as Parameters<CommandRuntime['list']>[0]

/** The public credential contract is enough; no local provider or real home is loaded. */
export class MemoryCredentials {
  values = new Map<string, string>()
  records = new Map<CredentialKey, CredentialRecord>()
  writes: string[] = []
  writable = true
  failWrite = false
  async resolve(ref: string) {
    const value = this.values.get(ref)
    return value === undefined ? undefined : { value, source: 'file' }
  }
  async describe(ref: string) {
    return { configured: this.values.has(ref), writable: this.writable, source: this.writable ? 'file' : 'env' }
  }
  async set(ref: string, value: string) {
    assert.equal(this.writable, true)
    if (this.failWrite) throw new Error('local credential write failed')
    this.values.set(ref, value)
    this.writes.push(ref)
  }
  async readRecord(key: CredentialKey) { return this.records.get(key) }
  async describeRecord(key: CredentialKey) {
    return { configured: this.records.has(key), writable: this.writable, kind: this.records.get(key)?.kind }
  }
  async listRecords() { return [...this.records].map(([key, record]) => ({ key, kind: record.kind })) }
  async modifyRecord(key: CredentialKey, change: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    if (this.failWrite) throw new Error('local credential write failed')
    const next = await change(this.records.get(key))
    if (next !== undefined) { this.records.set(key, next); this.writes.push(key) }
    return this.records.get(key)
  }
  async deleteRecord(key: CredentialKey) { this.records.delete(key) }
}

export const catalog = (record = false) => ({
  version: 1,
  providers: [{ id: ROUTE, name: 'Configured Go', source: SOURCE,
    auth: record ? { credentialProvider: SOURCE } : { apiKeyRef: REF },
    baseURL: ENDPOINT, headers: { 'x-login-test': SESSION }, fallbackSessionId: SESSION,
    models: [{ id: MODEL, name: 'Configured model' }],
  }],
  default: { provider: ROUTE, model: MODEL },
})

/** Tests drive the same public registry handler as an attended surface. */
export async function mountLogin(t: TestContext, options: {
  config?: object
  credentials?: MemoryCredentials | null
  ask?: LoginCommandHost['ask']
} = {}) {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  t.after(() => runtime.dispose())
  const commands = await ctx.plugin(CommandRuntime)
  t.after(() => commands.dispose())
  const store = options.credentials === undefined ? new MemoryCredentials() : options.credentials
  if (store !== null) {
    const credentials = await ctx.plugin((owner: Context) => owner.provide('credentials', store as never))
    t.after(() => credentials.dispose())
  }
  const prompts: Parameters<LoginCommandHost['ask']>[0][] = []
  const ui = await ctx.plugin((owner: Context) => owner.provide('userQuestions', {
    ask: async (request: Parameters<LoginCommandHost['ask']>[0]) => {
      prompts.push(request)
      if (options.ask) return options.ask(request)
      return { answers: request.questions.map(question => ({ id: question.id, selected: [], custom: KEY })) }
    },
  } as never))
  t.after(() => ui.dispose())
  const mounted = await ctx.plugin(plugin, (options.config ?? { catalog: catalog() }) as never)
  t.after(() => mounted.dispose())
  return { ctx, store, prompts, mounted,
    run: async (rawInput: string, signal = new AbortController().signal, name = COMMAND) => {
      const command = ctx.commands.find(AGENT, name)
      assert.ok(command, 'configured authentication command must be registered')
      return command.handler({ commandId: 'login-test-command', agent: AGENT, rawInput, attachments: [], signal } as unknown as CommandInvocation)
    },
  }
}

/** A successful local stream lets the real provider implementation check request shape. */
export function completionResponse(): Response {
  return new Response('data: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 0, model: MODEL,
    choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
  }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}
