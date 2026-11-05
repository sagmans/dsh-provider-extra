/** Subscription auth must not cross a topology change while awaiting its shared grant. */

import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { CodexCredentialService } from '../src/codex.ts'
import { recordKeyFor } from '../src/codex.ts'
import * as plugin from '../src/index.ts'
import { must } from './must.ts'

/** A competing plugin mounted beside the catalog; the tests only dispose it. */
type Mounted = { dispose(): unknown }

const SOURCE = 'openai-codex'
const ROUTE = 'subscription-alias'
/** The installed line names its own Codex models, so a hardcoded id does not exist on every line. */
const MODEL = must(builtinProviders().find((provider) => provider.id === SOURCE)).getModels()[0].id
const MODEL_NAME = 'Codex model'
const RELOADED_MODEL_NAME = 'Reloaded Codex model'
const ACCOUNT = 'local-account'
const REFRESH_TOKEN = 'local-refresh-token'
const ROTATED_REFRESH_TOKEN = 'local-rotated-refresh-token'
const AUTH_CLAIM = 'https://api.openai.com/auth'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const BASE_URL = 'http://127.0.0.1:1'
const MODEL_URL = `${BASE_URL}/codex/responses`
const NORMALIZED_ERROR = 'PI_AI_ERROR'
const EMPTY_RESPONSE = 'EMPTY_RESPONSE'
const RESPONSE_BODY =
  'data: ' +
  JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'local-response',
      status: 'completed',
      output: [],
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    },
  }) +
  '\n\n'
const COLLISION = 'CATALOG_OWNER_COLLISION'
const SELECTION = { provider: ROUTE, model: MODEL }
const ACCESS_TOKEN = [
  'header',
  Buffer.from(JSON.stringify({ [AUTH_CLAIM]: { chatgpt_account_id: ACCOUNT } })).toString(
    'base64url',
  ),
  'signature',
].join('.')
const VALID_FOR_SECONDS = 3600
const MILLISECONDS_PER_SECOND = 1000
const EXPIRED: CredentialRecord = {
  kind: 'grant',
  payload: {
    type: 'oauth',
    access: ACCESS_TOKEN,
    refresh: REFRESH_TOKEN,
    expires: 0,
    accountId: ACCOUNT,
  },
}
const STAGES = ['read', 'modify-lock', 'refresh', 'modify-completion'] as const
const TOPOLOGIES = ['collision', 'reload'] as const

type Stage = (typeof STAGES)[number]
type Topology = (typeof TOPOLOGIES)[number]

/** One auth boundary held open, so the test can change topology while auth waits on it. */
interface Boundary {
  readonly reached: Promise<void>
  readonly enter: () => Promise<void>
  readonly release: () => void
}

/** What the fake store saw committed; the outcome assertions read it after the race settles. */
interface StoreWrites {
  commits: number
  persisted: CredentialRecord | undefined
}

/** The generation a topology change replaces; the reload path needs only these two calls. */
interface Generation {
  update(config: never): unknown
  await(): Promise<unknown>
}

function holdBoundary(): Boundary {
  let entered!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    reached,
    release,
    enter: () => {
      entered()
      return gate
    },
  }
}

/** Only the transport is replaced: pi-ai's real OAuth refresh and store updater still execute. */
function mockTransport(
  t: TestContext,
  stage: Stage,
  topology: Topology,
  boundary: Boundary,
  requests: string[],
): void {
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
    await boundary.enter()
    return Response.json({
      access_token: ACCESS_TOKEN,
      refresh_token: ROTATED_REFRESH_TOKEN,
      expires_in: VALID_FOR_SECONDS,
    })
  })
}

/** A grant that is still valid, for stages where the updater must not need a refresh. */
function freshGrant(): CredentialRecord {
  return {
    kind: 'grant',
    payload: {
      type: 'oauth',
      access: ACCESS_TOKEN,
      refresh: REFRESH_TOKEN,
      expires: Date.now() + VALID_FOR_SECONDS * MILLISECONDS_PER_SECOND,
      accountId: ACCOUNT,
    },
  }
}

/** A store that stops at the stage under test, so the topology change lands exactly there. */
function gatedStore(stage: Stage, boundary: Boundary, writes: StoreWrites): CodexCredentialService {
  const fresh = freshGrant()
  return {
    async readRecord(key) {
      assert.equal(key, recordKeyFor(SOURCE), 'route aliases must not create a second OAuth grant')
      if (stage === 'read') {
        await boundary.enter()
        return undefined
      }
      return EXPIRED
    },
    async modifyRecord(key, change) {
      assert.equal(key, recordKeyFor(SOURCE))
      if (stage === 'modify-lock') await boundary.enter()
      const current = stage === 'refresh' ? EXPIRED : fresh
      const persisted = (await change(current)) ?? current
      writes.persisted = persisted
      writes.commits++
      if (stage === 'modify-completion') await boundary.enter()
      return persisted
    },
    async deleteRecord() {
      assert.fail('request auth must not delete the shared grant')
    },
    async listRecords() {
      return []
    },
  }
}

/** One Codex route on the aliased subscription, the shape whose grant the store must share. */
function catalogConfig() {
  return {
    catalog: {
      version: 1,
      providers: [
        {
          id: ROUTE,
          name: 'Codex',
          source: SOURCE,
          auth: { credentialProvider: SOURCE },
          baseURL: BASE_URL,
          transport: 'sse',
          models: [{ id: MODEL, name: MODEL_NAME }],
        },
      ],
      default: SELECTION,
    },
  }
}

/** A competing plugin arrives while auth waits. */
function mountCompetitor(ctx: Context): Promise<Mounted> {
  return ctx.plugin({
    inject: ['llm'],
    apply(owner: Context) {
      owner.llm.registerAdapter(['external'], {
        providerInfo: () => ({ id: 'external', name: 'External' }),
        providerRetryPolicy: () => undefined,
      } as never)
    },
  }) as unknown as Promise<Mounted>
}

/** A changed Config forces replacement, not a no-op update of the same generation. */
async function reloadCatalog(
  ctx: Context,
  mounted: Generation,
  config: ReturnType<typeof catalogConfig>,
): Promise<void> {
  const defaults = ctx.get('agentDefaultModel')
  const candidate = structuredClone(config)
  candidate.catalog.providers[0].models[0].name = RELOADED_MODEL_NAME
  // Cordis 4.0.3+ update() only schedules the restart; await() settles the new generation.
  mounted.update(candidate as never)
  await mounted.await()
  assert.notEqual(ctx.get('agentDefaultModel'), defaults)
  assert.equal((await ctx.llm.resolveModelInfo(ROUTE, MODEL)).name, RELOADED_MODEL_NAME)
}

/** What each stage and topology must leave behind once the held request settles. */
function assertOutcome(
  stage: Stage,
  topology: Topology,
  failure: LlmFailure,
  requests: readonly string[],
  writes: StoreWrites,
): void {
  const expectedCommits =
    stage === 'read' || (topology === 'collision' && stage === 'modify-lock') ? 0 : 1
  assert.equal(
    writes.commits,
    expectedCommits,
    'only a collision before updater entry may prevent its commit',
  )
  assert.deepEqual(requests, [
    ...(stage === 'refresh' ? [TOKEN_URL] : []),
    ...(topology === 'reload' && stage !== 'read' ? [MODEL_URL] : []),
  ])
  if (stage === 'refresh') {
    assert.equal(writes.persisted?.kind, 'grant')
    assert.equal(
      (writes.persisted?.payload as { refresh: string } | undefined)?.refresh,
      ROTATED_REFRESH_TOKEN,
    )
  }
  if (topology === 'collision') {
    assert.equal(failure.code, NORMALIZED_ERROR)
    assert.ok(failure.message.includes(COLLISION), failure.message)
  } else if (stage === 'read') assert.match(failure.message, /Provider is not configured:/)
  else
    assert.equal(
      failure.code,
      EMPTY_RESPONSE,
      'legitimate reload must reach the mocked model endpoint',
    )
}

for (const stage of STAGES)
  for (const topology of TOPOLOGIES) {
    test(`mounted Codex handles ${topology} during ${stage}`, async (t) => {
      const boundary = holdBoundary()
      const requests: string[] = []
      const writes: StoreWrites = { commits: 0, persisted: undefined }
      mockTransport(t, stage, topology, boundary, requests)
      const store = gatedStore(stage, boundary, writes)
      const ctx = new Context()
      const runtime = await ctx.plugin(LlmRuntime)
      const credentials = await ctx.plugin((owner: Context) => owner.provide('credentials', store))
      const config = catalogConfig()
      const mounted = await ctx.plugin(plugin, config as never)
      let external: Mounted | undefined
      try {
        const prepared = await ctx.llm.prepareCall(SELECTION)
        const result = (async (): Promise<LlmFailure> => {
          for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) {
            if (chunk.type === 'finish' && chunk.reason.kind === 'error')
              return chunk.reason.failure
          }
          throw new Error('expected a structured request failure')
        })()
        await Promise.race([
          boundary.reached,
          result.then(() => {
            throw new Error('auth finished before the delayed boundary')
          }),
        ])
        if (topology === 'collision') external = await mountCompetitor(ctx)
        else await reloadCatalog(ctx, mounted as unknown as Generation, config)
        boundary.release()
        assertOutcome(stage, topology, await result, requests, writes)
        await external?.dispose()
        assert.deepEqual(ctx.get('agentDefaultModel').currentSelection(), SELECTION)
      } finally {
        boundary.release()
        await external?.dispose()
        await mounted.dispose()
        await credentials.dispose()
        await runtime.dispose()
      }
    })
  }
