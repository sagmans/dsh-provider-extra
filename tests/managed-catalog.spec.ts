/** Managed ownership must never leak into ordinary additive compositions. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'

const ROUTE = 'openai'
const MODEL = 'gpt-5.6-luna'
const SELECTION = { provider: ROUTE, model: MODEL }
const catalog = () => ({
  version: 1,
  providers: [{ id: ROUTE, name: 'OpenAI API', source: ROUTE, auth: { apiKeyRef: 'OPENAI_API_KEY' }, models: [{ id: MODEL, name: 'GPT 5.6 Luna' }] }],
  default: { ...SELECTION },
})

/** A section mount would give a second document authority over managed membership. */
class ForbiddenSettings extends Service {
  constructor(ctx: Context) { super(ctx, 'settings') }
  installSection(): never { throw new Error('managed catalog must not install settings overlays') }
}

test('schema distinguishes absent, empty, and invalid catalog before activation', () => {
  assert.equal(plugin.Config({} as never).catalog, undefined)
  assert.deepEqual(plugin.Config({ catalog: { version: 1, providers: [], default: null } } as never).catalog,
    { version: 1, providers: [], default: null })
  assert.throws(() => plugin.Config({ catalog: null } as never))
  assert.throws(() => plugin.Config({ catalog: { ...catalog(), version: 2 } } as never))
})

test('managed snapshot owns listing, resolution and default without settings overlays', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const settings = await ctx.plugin(ForbiddenSettings)
  try {
    const mounted = await ctx.plugin(plugin, { catalog: catalog() } as never)
    try {
      assert.deepEqual(ctx.llm.listProviders(), [{ id: ROUTE, name: 'OpenAI API' }])
      assert.deepEqual((await ctx.llm.listModels(ROUTE)).map(model => [model.id, model.name]), [[MODEL, 'GPT 5.6 Luna']])
      assert.equal((await ctx.llm.resolveModelInfo(ROUTE, MODEL)).id, MODEL)
      const defaults = ctx.get('agentDefaultModel')
      assert.deepEqual(defaults.currentSelection(), SELECTION)
      await assert.rejects(defaults.saveSelection(SELECTION), { code: 'CONFIG_PERSISTENCE_UNAVAILABLE' })
      assert.deepEqual(defaults.currentSelection(), SELECTION)
    } finally { await mounted.dispose() }
  } finally { await settings.dispose(); await runtime.dispose() }
})

test('empty managed catalog selects none and never expands additive routes', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  try {
    const mounted = await ctx.plugin(plugin, { catalog: { version: 1, providers: [], default: null } } as never)
    try {
      assert.deepEqual(ctx.llm.listProviders(), [])
      assert.throws(() => ctx.get('agentDefaultModel').currentSelection(), { code: 'NO_DEFAULT_MODEL' })
    } finally { await mounted.dispose() }
  } finally { await runtime.dispose() }
})

test('invalid complete candidate mounts neither its valid route nor default service', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  try {
    const candidate = catalog()
    candidate.providers.push({ ...candidate.providers[0]!, id: 'broken', models: [{ id: 'missing-model', name: 'Missing' }] })
    await assert.rejects(async () => { await ctx.plugin(plugin, { catalog: candidate } as never) })
    assert.deepEqual(ctx.llm.listProviders(), [])
    assert.equal(ctx.get('agentDefaultModel'), undefined)
  } finally { await runtime.dispose() }
})

test('competing default owner rejects before managed routes mount', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const competing = await ctx.plugin((owner: Context) => { owner.provide('agentDefaultModel', {}) })
  try {
    await assert.rejects(async () => { await ctx.plugin(plugin, { catalog: catalog() } as never) }, { code: 'CATALOG_OWNER_COLLISION' })
    assert.deepEqual(ctx.llm.listProviders(), [])
  } finally { await competing.dispose(); await runtime.dispose() }
})

test('additive adapter ownership rejects managed catalog without partial registration', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const addon = await ctx.plugin(plugin, {} as never)
  try {
    const before = ctx.llm.listProviders()
    await assert.rejects(async () => { await ctx.plugin(plugin, { catalog: catalog() } as never) }, { code: 'CATALOG_OWNER_COLLISION' })
    assert.deepEqual(ctx.llm.listProviders(), before)
    assert.equal(ctx.get('agentDefaultModel'), undefined)
  } finally { await addon.dispose(); await runtime.dispose() }
})

test('successful reload replaces rows and defaults while prepared metadata retains its revision', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  try {
    const mounted = await ctx.plugin(plugin, { catalog: catalog() } as never)
    try {
      const prepared = await ctx.llm.prepareCall(SELECTION)
      const oldContext = structuredClone(prepared.context)
      const candidate = catalog()
      Object.assign(candidate.providers[0]!.models[0]!, { metadata: { contextWindow: 123456 } })
      await mounted.update({ catalog: candidate })
      const current = await ctx.llm.prepareCall(SELECTION)
      assert.notDeepEqual(current.context, oldContext)
      assert.deepEqual(prepared.context, oldContext)
      assert.deepEqual(ctx.get('agentDefaultModel').currentSelection(), SELECTION)
    } finally { await mounted.dispose() }
  } finally { await runtime.dispose() }
})

test('a competing adapter added later cannot tear down the valid catalog on reload', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const mounted = await ctx.plugin(plugin, { catalog: catalog() } as never)
  const external = await ctx.plugin({ inject: ['llm'], apply(owner: Context) {
    owner.llm.registerAdapter(['external'], {
      providerInfo: () => ({ id: 'external', name: 'External' }),
      providerRetryPolicy: () => undefined,
    } as never)
  } })
  try {
    await assert.rejects(async () => { await mounted.update({ catalog: catalog() }) }, { code: 'CATALOG_OWNER_COLLISION' })
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), [ROUTE, 'external'])
    await external.dispose()
    assert.deepEqual((await ctx.llm.listModels(ROUTE)).map(model => model.id), [MODEL])
    assert.deepEqual(ctx.get('agentDefaultModel').currentSelection(), SELECTION)
  } finally { await external.dispose(); await mounted.dispose(); await runtime.dispose() }
})

test('failed catalog reload preserves valid rows and default', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  try {
    const mounted = await ctx.plugin(plugin, { catalog: catalog() } as never)
    try {
      const candidate = catalog()
      candidate.providers[0]!.models[0]!.id = 'not-a-model'
      await assert.rejects(async () => { await mounted.update({ catalog: candidate } as never) })
      assert.deepEqual((await ctx.llm.listModels(ROUTE)).map(model => model.id), [MODEL])
      assert.deepEqual(ctx.get('agentDefaultModel').currentSelection(), SELECTION)
    } finally { await mounted.dispose() }
  } finally { await runtime.dispose() }
})
