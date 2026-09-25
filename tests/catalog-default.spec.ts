/** Profile persistence must write the same Config that supplies the default. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { compileCatalog } from '../src/catalog.ts'
import { catalogDefault } from '../src/catalog-default.ts'

const MODEL = 'gpt-5.6-luna'
const selection = { provider: 'openai', model: MODEL }
const catalog = {
  version: 1,
  providers: [{ id: 'openai', source: 'openai', name: 'API', auth: { apiKeyRef: 'OPENAI_API_KEY' }, models: [{ id: MODEL, name: 'Luna' }] }],
  default: selection,
}

test('configEditor edits only catalog.default and awaits canonical reconciliation', async () => {
  const ctx = new Context()
  const entry = { options: { config: { catalog, unrelated: { keep: true } } } }
  Object.assign(ctx.fiber, { entry })
  let stored = entry.options.config
  let settled = false
  const editor = {
    async edit(target: unknown, update: (raw: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) {
      assert.equal(target, entry)
      stored = update(stored, {}) as typeof stored
      await Promise.resolve()
      settled = true
    },
  }
  ctx.provide('configEditor', editor)
  const defaults = catalogDefault(ctx, compileCatalog(catalog)!)
  const next = { ...selection, reasoningEffort: 'high' }
  await defaults.saveSelection(next)
  assert.equal(settled, true)
  assert.deepEqual(stored, { catalog: { ...catalog, default: next }, unrelated: { keep: true } })
  assert.deepEqual(defaults.currentSelection(), selection, 'only host reconciliation activates the new snapshot')
})

test('writer revalidates latest catalog membership and never writes a second store', async () => {
  const ctx = new Context()
  Object.assign(ctx.fiber, { entry: {} })
  ctx.provide('configEditor', {
    async edit(_entry: unknown, update: (raw: Record<string, unknown>) => unknown) {
      update({ catalog: { version: 1, providers: [], default: null } })
    },
  })
  const defaults = catalogDefault(ctx, compileCatalog(catalog)!)
  await assert.rejects(defaults.saveSelection(selection))
  assert.deepEqual(defaults.currentSelection(), selection)
})

test('invalid effort is refused before invoking the profile writer', async () => {
  const ctx = new Context()
  Object.assign(ctx.fiber, { entry: {} })
  ctx.provide('configEditor', { edit() { assert.fail('invalid selection reached persistence') } })
  const defaults = catalogDefault(ctx, compileCatalog(catalog)!)
  await assert.rejects(defaults.saveSelection({ ...selection, reasoningEffort: 'impossible' }))
})

test('missing entry, missing editor and failed writer explicitly reject', async () => {
  const ctx = new Context()
  const defaults = catalogDefault(ctx, compileCatalog(catalog)!)
  await assert.rejects(defaults.saveSelection(selection), { code: 'CONFIG_PERSISTENCE_UNAVAILABLE' })
  Object.assign(ctx.fiber, { entry: {} })
  await assert.rejects(defaults.saveSelection(selection), { code: 'CONFIG_PERSISTENCE_UNAVAILABLE' })
  const failure = new Error('profile write refused')
  ctx.provide('configEditor', { async edit() { throw failure } })
  await assert.rejects(defaults.saveSelection(selection), error => error === failure)
  assert.deepEqual(defaults.currentSelection(), selection)
})
