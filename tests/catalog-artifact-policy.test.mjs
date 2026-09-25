/** Artifact policy rejects selections without recording any operator's model names. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { compileCatalog } from '@sagmans/dsh-provider-extra'
import { checkSelections } from '../tools/catalog-artifact-policy.mjs'

const SYNTHETIC = { catalog: { version: 1, providers: [{ id: 'example-route', source: 'example-source', models: [{ id: 'example-model', template: 'example-template' }] }], default: { provider: 'example-route', model: 'example-model' } } }

test('only synthetic provider/model declarations qualify as packaged examples', () => {
  assert.deepEqual(checkSelections(SYNTHETIC, 'example'), [])
  const real = structuredClone(SYNTHETIC)
  real.catalog.providers[0].id = 'selected-route'
  real.catalog.providers[0].models[0].id = 'selected-model'
  real.catalog.default.model = 'selected-model'
  assert.equal(checkSelections(real, 'example').length, 3)
})

test('legacy model selections and aliases also require synthetic identifiers', () => {
  for (const field of ['models', 'codexModels', 'extraModels', 'codexExtraModels']) {
    assert.equal(checkSelections({ config: { [field]: ['selected-model'] } }, 'example').length, 1)
    assert.deepEqual(checkSelections({ config: { [field]: ['example-model'] } }, 'example'), [])
  }
  assert.equal(checkSelections({ models: [{ id: 'example-model', aliases: ['selected-alias'] }] }, 'example').length, 1)
})

test('shipped example compiles with synthetic IDs and complete illustrative metadata', async () => {
  const config = JSON.parse(await readFile(new URL('../docs/catalog-v1.example.json', import.meta.url), 'utf8'))
  const snapshot = compileCatalog(config.catalog)
  assert.equal(snapshot.profiles.size, 1)
  assert.equal(snapshot.selection.model, 'example-model')
  assert.deepEqual(checkSelections(config, 'shipped example'), [])
})
