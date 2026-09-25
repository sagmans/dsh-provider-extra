/**
 * Proving a key against fakes: the provider answers with the one field the
 * decision reads, so a refusal stays distinguishable from a timeout and a
 * provider with no model never turns an unverified key into a stored credential.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Api, AssistantMessage, Credential, Model } from '@earendil-works/pi-ai'
import { PendingCredentialStore, proveApiKey } from '../src/login-verify.ts'
import type { KeyProbe } from '../src/login-verify.ts'

const MODEL = { id: 'some-model' } as Model<Api>
const PROVIDER_ID = 'anthropic'
const EMPTY_PROVIDER_ID = 'radius'
const PROBE_TIMEOUT_MS = 20_000
const NO_MODELS_ERROR = 'cannot verify this API key: no models are available for provider radius'
const CANCELLED = new Error('caller cancelled verification')
const TIMED_OUT = new DOMException('probe timed out', 'TimeoutError')

/** The province of an assistant message this decision reads; the rest is noise. */
function answer(stopReason: AssistantMessage['stopReason'], errorMessage?: string): AssistantMessage {
  return { stopReason, ...errorMessage === undefined ? {} : { errorMessage } } as AssistantMessage
}

/** A provider that ships the given models and answers every request the same way. */
function probeOf(models: readonly Model<Api>[], answered: AssistantMessage, asked?: { count: number }): KeyProbe {
  return {
    getModels: () => models,
    completeSimple: async () => {
      if (asked !== undefined) asked.count += 1
      return answered
    },
  } as unknown as KeyProbe
}

describe('proveApiKey', () => {
  it('accepts the answer a working key draws, whatever the model chose to do with the token', async () => {
    await proveApiKey(probeOf([MODEL], answer('length')), 'anthropic')
  })

  it('repeats the provider explanation instead of inventing one', async () => {
    await assert.rejects(
      proveApiKey(probeOf([MODEL], answer('error', '401 API key is invalid.')), 'anthropic'),
      /provider did not accept this API key: 401 API key is invalid\./u,
    )
  })

  it('blames a silent provider rather than the key', async () => {
    await assert.rejects(proveApiKey(probeOf([MODEL], answer('aborted')), 'anthropic'), /did not answer in time/u)
  })

  it('rejects a key that no model can verify without blaming the key', async () => {
    const asked = { count: 0 }
    await assert.rejects(
      proveApiKey(probeOf([], answer('error', 'never sent'), asked), EMPTY_PROVIDER_ID),
      { message: NO_MODELS_ERROR },
    )
    assert.equal(asked.count, 0)
  })

  it('does not inspect models or send a request when already cancelled', async (t) => {
    const controller = new AbortController()
    const models = probeOf([MODEL], answer('stop'))
    const listed = t.mock.method(models, 'getModels')
    const completed = t.mock.method(models, 'completeSimple')
    controller.abort(CANCELLED)
    await assert.rejects(proveApiKey(models, PROVIDER_ID, controller.signal), error => error === CANCELLED)
    assert.equal(listed.mock.callCount(), 0)
    assert.equal(completed.mock.callCount(), 0)
  })

  it('passes caller cancellation and its reason to the probe', async (t) => {
    const controller = new AbortController()
    const models = probeOf([MODEL], answer('stop'))
    let probeSignal: AbortSignal | undefined
    t.mock.method(models, 'completeSimple', async (...[_model, _context, options]: Parameters<KeyProbe['completeSimple']>) => {
      probeSignal = options?.signal
      controller.abort(CANCELLED)
      return answer('aborted')
    })
    await assert.rejects(proveApiKey(models, PROVIDER_ID, controller.signal), error => error === CANCELLED)
    assert.equal(probeSignal?.aborted, true)
    assert.equal(probeSignal?.reason, CANCELLED)
  })

  it('rejects a successful answer when the transport ignored caller cancellation', async (t) => {
    const controller = new AbortController()
    const models = probeOf([MODEL], answer('stop'))
    t.mock.method(models, 'completeSimple', async () => {
      controller.abort(CANCELLED)
      return answer('stop')
    })
    await assert.rejects(proveApiKey(models, PROVIDER_ID, controller.signal), error => error === CANCELLED)
  })

  it('retains the 20-second deadline when a caller signal is present', async (t) => {
    const controller = new AbortController()
    const deadline = new AbortController()
    const timeout = t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
    const models = probeOf([MODEL], answer('stop'))
    let probeSignal: AbortSignal | undefined
    t.mock.method(models, 'completeSimple', async (...[_model, _context, options]: Parameters<KeyProbe['completeSimple']>) => {
      probeSignal = options?.signal
      deadline.abort(TIMED_OUT)
      return answer('stop')
    })
    await assert.rejects(proveApiKey(models, PROVIDER_ID, controller.signal), error => error === TIMED_OUT)
    assert.equal(timeout.mock.calls[0]?.arguments[0], PROBE_TIMEOUT_MS)
    assert.equal(probeSignal?.aborted, true)
    assert.equal(probeSignal?.reason, TIMED_OUT)
    assert.equal(controller.signal.aborted, false)
  })

  it('rechecks the deadline without an optional caller signal', async (t) => {
    const deadline = new AbortController()
    t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
    const models = probeOf([MODEL], answer('stop'))
    t.mock.method(models, 'completeSimple', async () => {
      deadline.abort(TIMED_OUT)
      return answer('stop')
    })
    await assert.rejects(proveApiKey(models, PROVIDER_ID), error => error === TIMED_OUT)
  })
})

describe('PendingCredentialStore', () => {
  it('holds a credential as metadata and forgets it on delete', async () => {
    const store = new PendingCredentialStore()
    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-test' } as Credential))
    assert.deepEqual(await store.list(), [{ providerId: 'anthropic', type: 'api_key' }])
    assert.deepEqual(await store.read('anthropic'), { type: 'api_key', key: 'sk-test' })
    await store.delete('anthropic')
    assert.equal(await store.read('anthropic'), undefined)
  })
})
