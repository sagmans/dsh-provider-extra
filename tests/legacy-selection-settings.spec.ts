/** Settings publishes must not invalidate selections already validated from the entry. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import * as plugin from '../src/index.ts'
import type { ExtraModelSpec } from '../src/extra-models.ts'
import { DEFAULT_EXTRA_MODEL_TEMPLATE, OPENCODE_GO_PROVIDER_ID } from '../src/opencode-go.ts'
import { DEFAULT_CODEX_ROUTE_ID } from '../src/codex.ts'

const SETTINGS_SERVICE = 'settings'
const CODEX_TEMPLATE = 'gpt-5.6-luna'
const ENTRY_GO = { id: 'entry-go-model', name: 'Entry Go', template: DEFAULT_EXTRA_MODEL_TEMPLATE }
const ENTRY_CODEX = { id: 'entry-codex-model', name: 'Entry Codex', template: CODEX_TEMPLATE }
const UPDATED_GO = { ...ENTRY_GO, name: 'Settings Go' }
const UPDATED_CODEX = { ...ENTRY_CODEX, name: 'Settings Codex' }
const ADDED_GO = { ...ENTRY_GO, id: 'settings-go-model', name: 'Added Go' }
const ADDED_CODEX = { ...ENTRY_CODEX, id: 'settings-codex-model', name: 'Added Codex' }
const EMPTY_SECTION = { extraModels: [], codexExtraModels: [] }
const CHANGED_SECTION = {
  extraModels: [UPDATED_GO, ADDED_GO],
  codexExtraModels: [UPDATED_CODEX, ADDED_CODEX],
}
const PUBLISHES = [
  { name: 'empty extras', section: EMPTY_SECTION },
  { name: 'changed extras', section: CHANGED_SECTION },
]
const UNKNOWN_MODEL = 'UNKNOWN_MODEL'
const DYNAMIC_ROUTES = [
  {
    name: 'Go', route: OPENCODE_GO_PROVIDER_ID, entry: ENTRY_GO, updated: UPDATED_GO, added: ADDED_GO,
    otherRoute: DEFAULT_CODEX_ROUTE_ID, otherEntry: ENTRY_CODEX, selection: { codexModels: [ENTRY_CODEX.id] },
  },
  {
    name: 'Codex', route: DEFAULT_CODEX_ROUTE_ID, entry: ENTRY_CODEX, updated: UPDATED_CODEX, added: ADDED_CODEX,
    otherRoute: OPENCODE_GO_PROVIDER_ID, otherEntry: ENTRY_GO, selection: { models: [ENTRY_GO.id] },
  },
]

interface Section {
  extraModels: ExtraModelSpec[]
  codexExtraModels: ExtraModelSpec[]
}

/** The external settings seam can publish without touching documents or live homes. */
class PublishingSettings extends Service {
  private current: Section = EMPTY_SECTION
  private hooks?: SettingsSectionHooks<Section>

  constructor(ctx: Context) {
    super(ctx, SETTINGS_SERVICE)
  }

  installSection(_owner: Context, _namespace: string, _schema: unknown, entry: Section, hooks: SettingsSectionHooks<Section>): void {
    this.current = entry
    this.hooks = hooks
    hooks.setSource(() => this.current)
    hooks.onChange()
  }

  publish(section: Section): void {
    assert.ok(this.hooks)
    this.current = section
    this.hooks.onChange()
  }
}

/** Real plugin and LLM mounts keep profile rebuilding observable only through public calls. */
async function withProvider(
  selection: Partial<plugin.Config>,
  check: (ctx: Context, settings: PublishingSettings) => Promise<void>,
): Promise<void> {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  let settings!: PublishingSettings
  const settingsMount = await ctx.plugin((owner: Context) => { settings = new PublishingSettings(owner) })
  try {
    const mounted = await ctx.plugin(plugin, {
      extraModels: [ENTRY_GO],
      codexExtraModels: [ENTRY_CODEX],
      loginCommandEnabled: false,
      ...selection,
    } as never)
    try {
      await check(ctx, settings)
    } finally {
      await mounted.dispose()
    }
  } finally {
    await settingsMount.dispose()
    await runtime.dispose()
  }
}

for (const dynamic of DYNAMIC_ROUTES) {
  for (const selectOther of [false, true]) {
    test('unselected ' + dynamic.name + ' follows settings extras with other route selected: ' + selectOther, async () => {
      await withProvider(selectOther ? dynamic.selection : {}, async (ctx, settings) => {
        assert.ok((await ctx.llm.listModels(dynamic.route)).some(model => model.id === dynamic.entry.id))
        assert.equal((await ctx.llm.resolveModelInfo(dynamic.route, dynamic.entry.id)).name, dynamic.entry.name)

        settings.publish(CHANGED_SECTION)
        const changed = await ctx.llm.listModels(dynamic.route)
        for (const expected of [dynamic.updated, dynamic.added]) {
          assert.equal(changed.find(model => model.id === expected.id)?.name, expected.name)
          assert.equal((await ctx.llm.resolveModelInfo(dynamic.route, expected.id)).name, expected.name)
        }

        settings.publish(EMPTY_SECTION)
        const empty = await ctx.llm.listModels(dynamic.route)
        for (const removed of [dynamic.entry, dynamic.added]) {
          assert.ok(!empty.some(model => model.id === removed.id))
          await assert.rejects(ctx.llm.resolveModelInfo(dynamic.route, removed.id), { code: UNKNOWN_MODEL })
        }
        if (selectOther) {
          assert.deepEqual(
            (await ctx.llm.listModels(dynamic.otherRoute)).map(model => [model.id, model.name]),
            [[dynamic.otherEntry.id, dynamic.otherEntry.name]],
          )
          assert.equal((await ctx.llm.resolveModelInfo(dynamic.otherRoute, dynamic.otherEntry.id)).name, dynamic.otherEntry.name)
        }
      })
    })
  }
}

for (const published of PUBLISHES) {
  test('declared Go and Codex selections retain entry extras after publishing ' + published.name, async () => {
    await withProvider({ models: [ENTRY_GO.id], codexModels: [ENTRY_CODEX.id] }, async (ctx, settings) => {
      const assertSelections = async () => {
        for (const [route, model] of [
          [OPENCODE_GO_PROVIDER_ID, ENTRY_GO],
          [DEFAULT_CODEX_ROUTE_ID, ENTRY_CODEX],
        ] as const) {
          assert.deepEqual((await ctx.llm.listModels(route)).map(info => [info.id, info.name]), [[model.id, model.name]])
          const resolved = await ctx.llm.resolveModelInfo(route, model.id)
          assert.equal(resolved.id, model.id)
          assert.equal(resolved.name, model.name)
        }
      }
      await assertSelections()
      settings.publish(published.section)
      await assertSelections()
    })
  })
}
