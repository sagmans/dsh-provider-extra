/**
 * Behavior of the Codex subscription route: the profile re-keys the catalog
 * provider without touching its OAuth auth, the harness store round-trips
 * grants at the record address core shares, and the terminal login conducts
 * pi-ai's own OAuth conversation without ever printing a secret.
 *
 * A seeded in-memory credential service stands in for the credentials
 * document, and a scripted terminal stands in for the human, so every
 * assertion runs keyless. The one exception is pi-ai's own getAuth, which
 * runs unmocked against the seeded grant to prove the stored credential
 * actually resolves to request auth.
 *
 * @module dsh-provider-extra/tests
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createModels } from '@earendil-works/pi-ai'
import type { Credential } from '@earendil-works/pi-ai'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  CODEX_CATALOG_ID,
  DEFAULT_CODEX_DISPLAY_NAME,
  DEFAULT_CODEX_ROUTE_ID,
  HarnessCredentialStore,
  buildCodexProfile,
  codexApiKey,
  codexAuth,
  recordKeyFor,
  withTransport,
} from '../src/codex.ts'
import type { CodexCredentialService } from '../src/codex.ts'
import { answerPrompt, renderEvent, renderPrompt, runCodexLogin } from '../src/codex-login.ts'
import type { LoginModels, LoginTerminal } from '../src/codex-login.ts'
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

/** The route under test: the catalog id, so the grant address is shared. */
const route = { provider: DEFAULT_CODEX_ROUTE_ID, displayName: DEFAULT_CODEX_DISPLAY_NAME }

/** One catalog id and one sibling id the installed catalog ships. */
const CATALOG_MODEL_ID = 'gpt-5.6-luna'

/** A declared extra cloning the catalog sibling above, as a subscription-only id would. */
const DECLARED_EXTRA = { id: 'declared-extra-fixture', name: 'Declared extra fixture', template: CATALOG_MODEL_ID }

/** The served ids of one route configuration, in the order it advertises them. */
function servedIds(config: { models?: readonly string[]; extraModels?: { id: string; name?: string; template?: string }[] } = {}): string[] {
  return buildCodexProfile({ ...route, ...config }).piProvider!.getModels().map(model => model.id)
}

/** One fresh OAuth grant, as pi-ai's login would produce it. */
function grant(): Credential {
  return { type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires: Date.now() + 3600_000, accountId: 'account-1' }
}

/** An in-memory credentials service standing in for the document. */
function memoryService(seed: ReadonlyMap<string, CredentialRecord> = new Map()): CodexCredentialService & { records: Map<string, CredentialRecord> } {
  const records = new Map(seed)
  return {
    records,
    readRecord: (key) => Promise.resolve(records.get(String(key))),
    listRecords: () => Promise.resolve([...records].map(([key, record]) => ({
      key: key as unknown as CredentialKey,
      kind: record.kind,
    }))),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(String(key)))
      if (next !== undefined) records.set(String(key), next)
      return records.get(String(key))
    },
    deleteRecord: (key) => {
      records.delete(String(key))
      return Promise.resolve()
    },
  }
}

/** A scripted terminal answering every question from a queue. */
function scriptedTerminal(answers: string[]): LoginTerminal & { printed: string[]; asked: string[] } {
  const printed: string[] = []
  const asked: string[] = []
  const queue = [...answers]
  return {
    printed,
    asked,
    question: (prompt) => {
      asked.push(prompt)
      const answer = queue.shift()
      assert.notEqual(answer, undefined, 'terminal ran out of scripted answers for: ' + prompt)
      return Promise.resolve(answer as string)
    },
    print: (line) => { printed.push(line) },
    signal: new AbortController().signal,
  }
}

describe('codex record address', () => {
  it('shares core’s grant address instead of forking a second sign-in', () => {
    assert.equal(String(recordKeyFor(CODEX_CATALOG_ID)), String(credentialKey('llm-pi-ai', CODEX_CATALOG_ID)))
  })
})

describe('codex profile', () => {
  it('re-keys the catalog provider while keeping its OAuth auth', () => {
    const profile = buildCodexProfile(route)
    assert.equal(profile.provider, route.provider)
    assert.equal(profile.displayName, route.displayName)
    assert.equal(profile.apiKeyEnv, undefined)
    const provider = profile.piProvider
    assert.notEqual(provider, undefined)
    assert.equal(provider!.id, route.provider)
    assert.equal(provider!.name, route.displayName)
    assert.notEqual(provider!.auth.oauth, undefined)
    const models = provider!.getModels()
    assert.ok(models.length > 0, 'installed catalog ships codex models')
    for (const model of models) assert.equal(model.provider, route.provider)
  })

  it('resolves no per-request key, deferring to the stored grant', async () => {
    await assert.equal(await codexApiKey(), undefined)
  })

  it('pins the configured transport on a request and leaves other options alone', () => {
    const pinned = withTransport({ transport: 'auto', temperature: 0.2 }, { ...route, transport: 'sse' })
    assert.deepEqual(pinned, { transport: 'sse', temperature: 0.2 })
    // A route that pins none is not a route that overrides: pi-ai keeps choosing.
    assert.deepEqual(withTransport({ transport: 'websocket-cached' }, route), { transport: 'websocket-cached' })
    assert.equal(withTransport(undefined, { ...route, transport: 'sse' }), undefined)
  })

  it('resolves the transport a composition entry pins, and none when it pins nothing', () => {
    assert.equal(resolveConfig({ codexTransport: 'sse' }).codexTransport, 'sse')
    assert.equal(resolveConfig({}).codexTransport, undefined)
  })
})

describe('codex settings-declared extra models', () => {
  it('serves a declared model cloned from its template', () => {
    const profile = buildCodexProfile({
      ...route,
      extraModels: [{ id: 'declared-extra-fixture', name: 'Declared extra fixture', template: 'gpt-5.6-luna' }],
    })
    const models = profile.piProvider!.getModels()
    const extra = models.find(model => model.id === 'declared-extra-fixture')
    const template = models.find(model => model.id === 'gpt-5.6-luna')!
    assert.notEqual(extra, undefined, 'route serves the declared model')
    assert.equal(extra!.name, 'Declared extra fixture')
    assert.equal(extra!.api, template.api)
    assert.equal(extra!.contextWindow, template.contextWindow)
    assert.equal(extra!.maxTokens, template.maxTokens)
    // The catalog keeps dispatch and wire quirks; only identity answers to the route.
    assert.equal(extra!.provider, route.provider)
  })

  it('records an unknown template beside serviceable models', () => {
    const profile = buildCodexProfile({ ...route, extraModels: [{ id: 'declared-extra-fixture', template: 'no-such-model' }] })
    assert.ok(profile.modelErrors.has('declared-extra-fixture'), 'failure is diagnosable')
    assert.equal(profile.piProvider!.getModels().find(model => model.id === 'declared-extra-fixture'), undefined)
    // One mistyped declaration must not silence the subscription route.
    assert.ok(profile.piProvider!.getModels().length > 0)
  })

  it('records a declaration that names no template and clones nothing', () => {
    const profile = buildCodexProfile({ ...route, extraModels: [{ id: 'declared-extra-fixture' }] })
    assert.ok(profile.modelErrors.has('declared-extra-fixture'), 'a route with no shipped default must say so')
    assert.equal(profile.piProvider!.getModels().find(model => model.id === 'declared-extra-fixture'), undefined)
  })

  it('leaves a catalog-shipped id to the catalog', () => {
    const profile = buildCodexProfile({ ...route, extraModels: [{ id: 'gpt-5.4', name: 'Renamed' }] })
    assert.equal(profile.piProvider!.getModels().find(model => model.id === 'gpt-5.4')!.name, 'GPT-5.4')
  })
})

describe('codex exact model selection', () => {
  it('distills the composition entry into the models the entry itself carries', () => {
    const resolved = resolveConfig({ codexExtraModels: [DECLARED_EXTRA], codexModels: [DECLARED_EXTRA.id] })
    assert.deepEqual(resolved.codexModels, [DECLARED_EXTRA.id])
    assert.deepEqual(resolved.codexExtraModels?.[0]?.template, CATALOG_MODEL_ID)
  })

  it('serves everything the catalog and the extras resolved when no selection is declared', () => {
    const ids = servedIds({ extraModels: [DECLARED_EXTRA] })
    assert.ok(ids.includes(CATALOG_MODEL_ID))
    assert.ok(ids.includes(DECLARED_EXTRA.id))
    assert.ok(ids.length > 2, 'the catalog stays whole')
  })

  it('serves only the declared ids, in the declared order', () => {
    // Catalog last: the declaration, not the catalog, decides the order.
    assert.deepEqual(servedIds({ models: [DECLARED_EXTRA.id, CATALOG_MODEL_ID], extraModels: [DECLARED_EXTRA] }), [DECLARED_EXTRA.id, CATALOG_MODEL_ID])
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
      () => buildCodexProfile({ ...route, models: [CATALOG_MODEL_ID, 'no-such-model'] }),
      (error: unknown) => error instanceof LlmError
        && /UNKNOWN_MODEL/.test(error.code)
        && error.message.includes(route.provider)
        && error.message.includes('no-such-model'),
    )
  })

  it('refuses a selected extra whose template does not resolve', () => {
    assert.throws(
      () => buildCodexProfile({ ...route, models: [DECLARED_EXTRA.id], extraModels: [{ id: DECLARED_EXTRA.id, template: 'no-such-model' }] }),
      (error: unknown) => error instanceof LlmError && error.message.includes(DECLARED_EXTRA.id),
    )
  })
})

describe('harness credential store', () => {
  it('reads nothing without a service and ignores foreign ids', async () => {
    const bare = new HarnessCredentialStore(() => undefined)
    await assert.equal(await bare.read(CODEX_CATALOG_ID), undefined)
    await assert.deepEqual(await bare.list(), [])
    const keyed = new HarnessCredentialStore(() => memoryService())
    await assert.equal(await keyed.read('UPPER.DOTTED'), undefined)
  })

  it('round-trips an OAuth grant the way a login writes it', async () => {
    const service = memoryService()
    const store = new HarnessCredentialStore(() => service)
    // One instance: the grant carries a timestamp, so a second factory call
    // would differ by a millisecond and fail for no reason.
    const original = grant()
    const written = await store.modify(CODEX_CATALOG_ID, async () => original)
    assert.equal(written?.type, 'oauth')
    const read = await store.read(CODEX_CATALOG_ID)
    assert.deepEqual(read, original)
    const record = service.records.get(String(recordKeyFor(CODEX_CATALOG_ID)))
    assert.equal(record?.kind, 'grant')
  })

  it('stores the JSON image, dropping members JSON cannot hold', async () => {
    const service = memoryService()
    const store = new HarnessCredentialStore(() => service)
    const shaped = { ...grant(), extra: undefined } as unknown as Credential
    await store.modify(CODEX_CATALOG_ID, async () => shaped)
    const record = service.records.get(String(recordKeyFor(CODEX_CATALOG_ID)))
    assert.equal(record?.kind, 'grant')
    assert.ok(!('extra' in ((record as { payload: Record<string, unknown> }).payload)))
  })

  it('hands the current grant to a refresh and reports foreign scopes as others’', async () => {
    const foreign = credentialKey('other-plugin', 'other-id')
    const service = memoryService(new Map([
      [String(foreign), { kind: 'api-key', key: 'k' }],
    ]))
    const store = new HarnessCredentialStore(() => service)
    const original = grant()
    await store.modify(CODEX_CATALOG_ID, async () => original)
    let seen: Credential | undefined = { type: 'api_key' }
    const rotated: Credential = { type: 'oauth', access: 'new-access', refresh: 'new-refresh', expires: Date.now() + 3600_000, accountId: 'account-1' }
    await store.modify(CODEX_CATALOG_ID, async (current) => {
      seen = current
      return rotated
    })
    assert.deepEqual(seen, original)
    assert.deepEqual(await store.read(CODEX_CATALOG_ID), rotated)
    assert.deepEqual(await store.list(), [{ providerId: CODEX_CATALOG_ID, type: 'oauth' }])
  })

  it('refuses writes with nowhere to store and ids with nowhere to address', async () => {
    const bare = new HarnessCredentialStore(() => undefined)
    await assert.rejects(() => bare.modify(CODEX_CATALOG_ID, async () => grant()), /nowhere to store/)
    const keyed = new HarnessCredentialStore(() => memoryService())
    await assert.rejects(() => keyed.modify('UPPER.DOTTED', async () => grant()), /cannot address/)
    await keyed.delete('UPPER.DOTTED')
  })

  it('deletes the grant on sign-out', async () => {
    const service = memoryService()
    const store = new HarnessCredentialStore(() => service)
    await store.modify(CODEX_CATALOG_ID, async () => grant())
    await store.delete(CODEX_CATALOG_ID)
    await assert.equal(await store.read(CODEX_CATALOG_ID), undefined)
  })

  it('resolves request auth from the stored grant through real pi-ai plumbing', async () => {
    const service = memoryService()
    const store = new HarnessCredentialStore(() => service)
    await store.modify(CODEX_CATALOG_ID, async () => grant())
    const models = createModels(codexAuth(() => service))
    models.setProvider(buildCodexProfile(route).piProvider!)
    const model = buildCodexProfile(route).piProvider!.getModels()[0]!
    const resolved = await models.getAuth(model, {})
    assert.equal(resolved?.auth.apiKey, 'access-token')
  })
})

describe('terminal login', () => {
  it('renders every pi-ai event with its URL and code, never a secret', () => {
    assert.deepEqual(renderEvent({ type: 'progress', message: 'Exchanging the code' }), ['Exchanging the code'])
    assert.deepEqual(
      renderEvent({ type: 'auth_url', url: 'https://auth.example/start', instructions: 'Approve in the tab' }),
      ['Approve in the tab', 'https://auth.example/start'],
    )
    assert.deepEqual(
      renderEvent({ type: 'auth_url', url: 'https://auth.example/plain' }),
      ['Open this page to continue signing in:', 'https://auth.example/plain'],
    )
    const device = renderEvent({ type: 'device_code', userCode: 'WXYZ-1234', verificationUri: 'https://device.example' })
    assert.ok(device.some(line => line.includes('https://device.example')))
    assert.ok(device.some(line => line.includes('WXYZ-1234')))
    assert.deepEqual(renderEvent({ type: 'info', message: 'Read this', links: [{ url: 'https://help.example' }] }), ['Read this https://help.example'])
    assert.deepEqual(renderEvent({ type: 'info', message: 'Plain' }), ['Plain'])
  })

  it('answers a select by id, whether the human typed the number or the id', async () => {
    const prompt = renderPrompt({
      type: 'select',
      message: 'Select method:',
      options: [{ id: 'browser', label: 'Browser login' }, { id: 'device_code', label: 'Device code' }],
    })
    assert.ok(prompt.options !== undefined)
    const byNumber = scriptedTerminal(['2'])
    await assert.equal(await answerPrompt(byNumber, {
      type: 'select',
      message: 'Select method:',
      options: [{ id: 'browser', label: 'Browser login' }, { id: 'device_code', label: 'Device code' }],
    }), 'device_code')
    const byId = scriptedTerminal(['browser'])
    await assert.equal(await answerPrompt(byId, {
      type: 'select',
      message: 'Select method:',
      options: [{ id: 'browser', label: 'Browser login' }, { id: 'device_code', label: 'Device code' }],
    }), 'browser')
    const lost = scriptedTerminal(['7'])
    await assert.rejects(() => answerPrompt(lost, {
      type: 'select',
      message: 'Select method:',
      options: [{ id: 'browser', label: 'Browser login' }],
    }), /answer the prompt/)
  })

  it('passes text answers through with their placeholder hint', async () => {
    const terminal = scriptedTerminal(['pasted-code'])
    const answer = await answerPrompt(terminal, { type: 'manual_code', message: 'Paste the code', placeholder: 'http://localhost:1455/auth/callback' })
    assert.equal(answer, 'pasted-code')
    assert.ok(terminal.asked[0]!.includes('http://localhost:1455/auth/callback'))
  })

  it('conducts the login against pi-ai’s own conversation and prints no secret', async () => {
    const seen: { providerId?: string; type?: string } = {}
    const terminal = scriptedTerminal(['2'])
    const models: LoginModels = {
      setProvider: () => {},
      login: async (providerId, type, interaction) => {
        seen.providerId = providerId
        seen.type = type
        const choice = await interaction.prompt({
          type: 'select',
          message: 'Select OpenAI Codex login method:',
          options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }],
        })
        assert.equal(choice, 'device_code')
        interaction.notify({ type: 'device_code', userCode: 'WXYZ-1234', verificationUri: 'https://device.example' })
        return grant()
      },
    }
    await runCodexLogin(models, { id: CODEX_CATALOG_ID }, terminal)
    assert.deepEqual(seen, { providerId: CODEX_CATALOG_ID, type: 'oauth' })
    assert.ok(terminal.printed.some(line => line.includes('WXYZ-1234')))
    assert.ok(terminal.printed.some(line => line.includes('Signed in')))
    for (const line of terminal.printed) {
      assert.ok(!line.includes('access-token'), 'output must never carry the access token')
      assert.ok(!line.includes('refresh-token'), 'output must never carry the refresh token')
    }
  })
})
