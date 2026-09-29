/**
 * A line that publishes forms from each entry's own Config has no section to
 * install, and the entry carries the extras instead: a committed form edit
 * writes the profile patch, the Loader validates it, and the entry is
 * re-applied. This spec pins both halves — the mount must not reach for a
 * section API that line does not publish, and a committed change must reach the
 * route without a process restart.
 *
 * @module dsh-provider-extra/tests
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { DEFAULT_EXTRA_MODEL_TEMPLATE, OPENCODE_GO_PROVIDER_ID } from '../src/opencode-go.ts'

const SETTINGS_SERVICE = 'settings'
const ENTRY_GO = { id: 'entry-go-model', name: 'Entry Go', template: DEFAULT_EXTRA_MODEL_TEMPLATE }
const COMMITTED_GO = { id: 'committed-go-model', name: 'Committed Go', template: DEFAULT_EXTRA_MODEL_TEMPLATE }

/**
 * The 0.1.7 shape: forms derived from Config, and no reader, writer, or section
 * installer for a namespace.
 */
class ConfigBackedSettings extends Service {
  constructor(ctx: Context) {
    super(ctx, SETTINGS_SERVICE)
  }
}

test('extras mount and commit on a line whose settings service publishes no section', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const settingsMount = await ctx.plugin((owner: Context) => { void new ConfigBackedSettings(owner) })
  try {
    const mounted = await ctx.plugin(plugin, {
      extraModels: [ENTRY_GO],
      loginCommandEnabled: false,
    } as never)
    try {
      assert.equal((await ctx.llm.resolveModelInfo(OPENCODE_GO_PROVIDER_ID, ENTRY_GO.id)).name, ENTRY_GO.name)

      // What a committed form edit does to this entry: the profile patch carries
      // the new value, and the Loader re-applies the plugin with it.
      await mounted.update({ extraModels: [COMMITTED_GO], loginCommandEnabled: false })
      assert.equal((await ctx.llm.resolveModelInfo(OPENCODE_GO_PROVIDER_ID, COMMITTED_GO.id)).name, COMMITTED_GO.name)
      await assert.rejects(ctx.llm.resolveModelInfo(OPENCODE_GO_PROVIDER_ID, ENTRY_GO.id), { code: 'UNKNOWN_MODEL' })
    } finally {
      await mounted.dispose()
    }
  } finally {
    await settingsMount.dispose()
    await runtime.dispose()
  }
})
