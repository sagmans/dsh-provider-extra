import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'

const PACKAGE_NAME = '@sagmans/dsh-provider-extra'
const GO_ROUTE = 'opencode-go'
const CODEX_ROUTE = 'openai-codex'
const EXTRA_MODEL = 'deepseek-flash'
const CATALOG_MODEL = 'deepseek-v4.1-flash'
const ENTRY_EXTRA_MODEL = 'entry-flash'
const CODEX_EXTRA_MODEL = 'example-codex-model'
const CODEX_EXTRA_TEMPLATE = 'gpt-5.6-luna'
const GO_KEY_REF = 'OPENCODE_API_KEY'
const GO_TEST_KEY = 'local-test-key'

/**
 * Harness 0.2.1 lists a route's models only once its key resolves, so the Go
 * route is listed against an in-memory key: no real credential, and no
 * dependence on whatever the developer's shell exports.
 */
function withGoKey(ctx) {
  return ctx.plugin((owner) => owner.provide('credentials', {
    resolve: async (ref) => ref === GO_KEY_REF ? { value: GO_TEST_KEY } : undefined,
  }))
}

/**
 * The settings seam the plugin installs its section on. It resolves the
 * section schema the way the file provider does, so a key the schema drops
 * fails here instead of never reaching a route.
 */
class SettingsDocument extends Service {
  constructor(ctx) {
    super(ctx, 'settings')
    this.schema = undefined
    this.value = undefined
    this.hooks = undefined
  }

  installSection(_owner, _ns, schema, entry, hooks) {
    this.schema = schema
    // The section layer sits over the entry, so a published document has to
    // win key by key the way the file provider resolves it, arrays included.
    this.base = entry
    this.value = schema(entry)
    this.hooks = hooks
    hooks.setSource(() => this.value)
    hooks.onChange()
  }

  /** Commit a user layer, as a settings write does. */
  publish(section) {
    this.value = this.schema({ ...this.base, ...section })
    this.hooks.onChange()
  }
}

test('built package mounts both routes without stored credentials or a TypeScript loader', async () => {
  const plugin = await import(PACKAGE_NAME)
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const credentials = await withGoKey(ctx)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, {})
    const go = await ctx.llm.listModels(GO_ROUTE)
    const codex = await ctx.llm.listModels(CODEX_ROUTE)
    assert.ok(go.some((model) => model.id === EXTRA_MODEL))
    assert.ok(codex.length > 0)
  } finally {
    await mounted?.dispose()
    await credentials.dispose()
    await runtime.dispose()
  }
})

test('entry-declared extras reach both routes with no settings document at all', async () => {
  const plugin = await import(PACKAGE_NAME)
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const credentials = await withGoKey(ctx)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, {
      extraModels: [{ id: ENTRY_EXTRA_MODEL, template: CATALOG_MODEL }],
      codexExtraModels: [{ id: CODEX_EXTRA_MODEL, name: 'GPT-6 Luna', template: CODEX_EXTRA_TEMPLATE }],
    })
    const go = await ctx.llm.listModels(GO_ROUTE)
    const codex = await ctx.llm.listModels(CODEX_ROUTE)
    assert.ok(go.some((model) => model.id === ENTRY_EXTRA_MODEL), 'entry extras reach the Go route')
    assert.ok(go.some((model) => model.id === EXTRA_MODEL), 'shipped extras stay served')
    assert.ok(codex.some((model) => model.id === CODEX_EXTRA_MODEL), 'entry extras reach the Codex route')
  } finally {
    await mounted?.dispose()
    await credentials.dispose()
    await runtime.dispose()
  }
})

test('entry-declared selections narrow each route to exactly those models, in order', async () => {
  const plugin = await import(PACKAGE_NAME)
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const credentials = await withGoKey(ctx)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, {
      extraModels: [{ id: ENTRY_EXTRA_MODEL, template: CATALOG_MODEL }],
      models: [ENTRY_EXTRA_MODEL, CATALOG_MODEL],
      codexExtraModels: [{ id: CODEX_EXTRA_MODEL, name: 'GPT-6 Luna', template: CODEX_EXTRA_TEMPLATE }],
      codexModels: [CODEX_EXTRA_MODEL, CODEX_EXTRA_TEMPLATE],
    })
    assert.deepEqual((await ctx.llm.listModels(GO_ROUTE)).map((model) => model.id), [ENTRY_EXTRA_MODEL, CATALOG_MODEL])
    assert.deepEqual((await ctx.llm.listModels(CODEX_ROUTE)).map((model) => model.id), [CODEX_EXTRA_MODEL, CODEX_EXTRA_TEMPLATE])
  } finally {
    await mounted?.dispose()
    await credentials.dispose()
    await runtime.dispose()
  }
})

test('a selection that names nothing fails the composition, naming the route and the id', async () => {
  const plugin = await import(PACKAGE_NAME)
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const credentials = await withGoKey(ctx)
  try {
    await assert.rejects(
      async () => { await ctx.plugin(plugin, { models: ['no-such-model'] }) },
      (error) => error?.code === 'UNKNOWN_MODEL'
        && error.message.includes(GO_ROUTE)
        && error.message.includes('no-such-model'),
    )
  } finally {
    await credentials.dispose()
    await runtime.dispose()
  }
})

test('settings-declared extras override the entry\'s own, per key', async () => {
  const plugin = await import(PACKAGE_NAME)
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const credentials = await withGoKey(ctx)
  const settings = await ctx.plugin(SettingsDocument)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, {
      extraModels: [{ id: ENTRY_EXTRA_MODEL, template: CATALOG_MODEL }],
      codexExtraModels: [{ id: CODEX_EXTRA_MODEL, name: 'GPT-6 Luna', template: CODEX_EXTRA_TEMPLATE }],
    })
    assert.ok((await ctx.llm.listModels(GO_ROUTE)).some((model) => model.id === ENTRY_EXTRA_MODEL))

    ctx.settings.publish({
      extraModels: [{ id: 'section-flash', template: CATALOG_MODEL }],
      codexExtraModels: [{ id: 'section-luna', template: CODEX_EXTRA_TEMPLATE }],
    })

    const go = await ctx.llm.listModels(GO_ROUTE)
    const codex = await ctx.llm.listModels(CODEX_ROUTE)
    assert.ok(go.some((model) => model.id === 'section-flash'), 'the section is what the route serves')
    assert.equal(go.some((model) => model.id === ENTRY_EXTRA_MODEL), false, 'the entry declaration is overridden, not merged')
    assert.ok(codex.some((model) => model.id === 'section-luna'))
    assert.equal(codex.some((model) => model.id === CODEX_EXTRA_MODEL), false)
  } finally {
    await mounted?.dispose()
    await settings.dispose()
    await credentials.dispose()
    await runtime.dispose()
  }
})

test('settings-declared codex extras reach the route without a restart', async () => {
  const plugin = await import(PACKAGE_NAME)
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const credentials = await withGoKey(ctx)
  const settings = await ctx.plugin(SettingsDocument)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, {})
    const before = await ctx.llm.listModels(CODEX_ROUTE)
    assert.equal(before.some((model) => model.id === CODEX_EXTRA_MODEL), false)

    ctx.settings.publish({
      extraModels: [],
      codexExtraModels: [{ id: CODEX_EXTRA_MODEL, name: 'GPT-6 Luna', template: CODEX_EXTRA_TEMPLATE }],
    })

    const after = await ctx.llm.listModels(CODEX_ROUTE)
    const extra = after.find((model) => model.id === CODEX_EXTRA_MODEL)
    assert.ok(extra, 'the committed declaration is served')
    assert.equal(extra.name, 'GPT-6 Luna')
    assert.ok(after.some((model) => model.id === CODEX_EXTRA_TEMPLATE), 'the template stays served')
  } finally {
    await mounted?.dispose()
    await settings.dispose()
    await credentials.dispose()
    await runtime.dispose()
  }
})
