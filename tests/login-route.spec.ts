/**
 * The route declaration against fakes: the settings service stands in for the
 * harness namespace, and the assertions are on the write itself. A patch that
 * restated the providers dict would drop every route a profile configured,
 * which is the failure this shape exists to prevent.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { declareProviderRoute, declaredCredentialRef, legacySettings } from '../src/login-route.ts'
import type { SettingsLike } from '../src/login-route.ts'

/** A settings service over one fixed namespace value, recording every write. */
function settingsOf(value: unknown): { settings: SettingsLike; written: object[] } {
  const written: object[] = []
  return {
    written,
    settings: {
      get: () => value,
      update: async (_namespace, patch) => {
        written.push(patch)
      },
    },
  }
}

describe('declaring a provider route', () => {
  it('adds one catalog route beside the routes a profile already configured', async () => {
    const { settings, written } = settingsOf({ providers: { 'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY' } } })
    assert.equal(await declareProviderRoute(settings, 'qwen-token-plan-individual'), 'declared')
    assert.deepEqual(written, [{ providers: { 'qwen-token-plan-individual': {} } }])
  })

  it('leaves a configured route alone, so its own overrides survive', async () => {
    const { settings, written } = settingsOf({ providers: { 'qwen-token-plan-individual': { apiKeyEnv: 'QWEN_KEY' } } })
    assert.equal(await declareProviderRoute(settings, 'qwen-token-plan-individual'), 'present')
    assert.deepEqual(written, [])
  })

  it('reports a composition with no settings service, or none that owns the namespace', async () => {
    const { settings } = settingsOf(undefined)
    assert.equal(await declareProviderRoute(undefined, 'qwen-token-plan-individual'), 'unavailable')
    assert.equal(await declareProviderRoute(settings, 'qwen-token-plan-individual'), 'unavailable')
  })
})

describe('the settings seam a running line publishes', () => {
  it('hands the document seam through when the line owns one', () => {
    const { settings } = settingsOf({ providers: {} })
    assert.equal(legacySettings(settings), settings)
  })

  it('refuses a forms service, a partial service, and an unmounted one', () => {
    // The 0.1.7 shape: forms over Config, with no reader for a namespace. It
    // must not be handed on, because the first read would throw inside a
    // sign-in rather than report the moved seam.
    const forms = { describe: () => [], update: async () => {}, configure: () => () => {} }
    assert.equal(legacySettings(forms), undefined)
    assert.equal(legacySettings({ get: () => ({}) }), undefined)
    assert.equal(legacySettings({ update: async () => {} }), undefined)
    assert.equal(legacySettings(undefined), undefined)
  })

  it('reports a declaration without a route as unavailable rather than failing', async () => {
    const forms = { describe: () => [], update: async () => {} }
    assert.equal(await declareProviderRoute(legacySettings(forms), 'qwen-token-plan-individual'), 'unavailable')
  })
})

describe('reading a declared route credential', () => {
  it('names the reference a configured route resolves', () => {
    const { settings } = settingsOf({ providers: { 'kimi-coding': { apiKeyEnv: 'KIMI_CODING_API_KEY' } } })
    assert.equal(declaredCredentialRef(settings, 'kimi-coding'), 'KIMI_CODING_API_KEY')
  })

  it('reports nothing for a route without a reference, a malformed one, or no settings at all', () => {
    const { settings } = settingsOf({
      providers: { 'qwen-token-plan-individual': {}, 'zai-coding-cn': { apiKeyEnv: 42 } },
    })
    assert.equal(declaredCredentialRef(settings, 'qwen-token-plan-individual'), undefined)
    assert.equal(declaredCredentialRef(settings, 'zai-coding-cn'), undefined)
    assert.equal(declaredCredentialRef(settings, 'absent'), undefined)
    assert.equal(declaredCredentialRef(undefined, 'kimi-coding'), undefined)
  })
})
