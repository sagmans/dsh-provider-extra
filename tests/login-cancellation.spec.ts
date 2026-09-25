/** Caller cancellation must stop pending work without denying an already committed sign-in. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { AuthPrompt } from '@earendil-works/pi-ai'
import { createLoginCommand, DEFAULT_LOGIN_COMMAND_NAME } from '../src/login-command.ts'
import { StoredCredentialError } from '../src/login-contract.ts'
import { KEY_WORD, OAUTH_WORD } from '../src/login-choice.ts'
import type { LoginAuthType, LoginChoice, LoginCommandHost } from '../src/login-contract.ts'

const CHOICE: LoginChoice = {
  providerId: 'anthropic',
  providerName: 'Anthropic',
  authType: 'oauth',
  methodLabel: 'Anthropic subscription',
}
const KEY_CHOICE: LoginChoice = { ...CHOICE, authType: 'api_key', methodLabel: 'Anthropic API key' }
const CHOICES = [CHOICE, KEY_CHOICE]
const COMMAND_ID = 'cancel-login'
const AGENT_ID = 'test-agent'
const CANCELLED = new Error('caller cancelled sign-in')
const CANCELLED_TEXT = 'The Anthropic sign-in was cancelled.'
const STORED_UNAVAILABLE = 'The credential was stored, but the route is unavailable: CATALOG_OWNER_COLLISION'
const READBACK_DETAIL = 'local credential read failed'
const READBACK_FAILURE = 'The sign-in completed, but credential readback failed: ' + READBACK_DETAIL
const READBACK_CANCELLATION = [false, true]
const UNEXPECTED_QUESTION = 'unexpected question'
const QUESTION_ID = 'prompt'
const ANSWER = 'test-answer'
const DEVICE_CODE = 'TEST-CODE'
const DEVICE_URL = 'https://example.test/device'
const PROMPTS: AuthPrompt[] = [
  { type: 'secret', message: 'API key' },
  { type: 'text', message: 'Account name' },
  { type: 'select', message: 'Plan', options: [{ id: ANSWER, label: ANSWER }] },
  { type: 'manual_code', message: 'Browser code' },
]

/** The command requires an agent identity, not a real profile or session. */
function invocation(choice: LoginChoice, signal: AbortSignal): CommandInvocation {
  return {
    commandId: COMMAND_ID,
    agent: { id: AGENT_ID },
    rawInput: choice.providerId + ' ' + (choice.authType === 'api_key' ? KEY_WORD : OAUTH_WORD),
    attachments: [],
    signal,
  } as unknown as CommandInvocation
}

/** Keeping durability observable avoids mistaking cancellation for credential rollback. */
function makeHost(
  login: LoginCommandHost['login'],
  ask: LoginCommandHost['ask'] = async () => { throw new Error(UNEXPECTED_QUESTION) },
  stored: Map<string, LoginAuthType> = new Map(),
): LoginCommandHost {
  return {
    choices: () => CHOICES,
    login,
    ask,
    stored: async providerId => stored.get(providerId),
    reference: async () => undefined,
  }
}

describe('login caller cancellation', () => {
  it('does not enter the host when the invocation is already cancelled', async () => {
    const controller = new AbortController()
    let entered = false
    const host = makeHost(async () => {
      entered = true
      return 'present'
    })
    controller.abort(CANCELLED)
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(invocation(CHOICE, controller.signal))
    assert.equal(entered, false)
    assert.deepEqual(result, { kind: 'error', text: CANCELLED_TEXT })
  })

  it('passes cancellation and its reason into an active host login', async () => {
    const controller = new AbortController()
    let loginSignal: AbortSignal | undefined
    const host = makeHost(async (_choice, interaction) => {
      loginSignal = interaction.signal
      controller.abort(CANCELLED)
      interaction.signal?.throwIfAborted()
      return 'present'
    })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(invocation(CHOICE, controller.signal))
    assert.equal(loginSignal?.aborted, true)
    assert.equal(loginSignal?.reason, CANCELLED)
    assert.deepEqual(result, { kind: 'error', text: CANCELLED_TEXT })
  })

  for (const prompt of PROMPTS) {
    it('passes caller cancellation into a pending ' + prompt.type + ' question', async () => {
      const controller = new AbortController()
      let questionSignal: AbortSignal | undefined
      const host = makeHost(async (_choice, interaction) => {
        await interaction.prompt(prompt)
        return 'present'
      }, async request => {
        questionSignal = request.signal
        controller.abort(CANCELLED)
        request.signal?.throwIfAborted()
        return { answers: [{ id: request.questions[0]?.id ?? QUESTION_ID, selected: [ANSWER], custom: ANSWER }] }
      })
      const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(invocation(CHOICE, controller.signal))
      assert.equal(questionSignal?.aborted, true)
      assert.equal(questionSignal?.reason, CANCELLED)
      assert.deepEqual(result, { kind: 'error', text: CANCELLED_TEXT })
    })
  }

  it('withdraws the waiting device question before the host login settles', async () => {
    const controller = new AbortController()
    let questionSignal: AbortSignal | undefined
    let withdrawnBeforeHostSettled = false
    const host = makeHost(async (_choice, interaction) => {
      interaction.notify({ type: 'device_code', userCode: DEVICE_CODE, verificationUri: DEVICE_URL })
      controller.abort(CANCELLED)
      withdrawnBeforeHostSettled = questionSignal?.aborted === true
      throw CANCELLED
    }, request => {
      questionSignal = request.signal
      return new Promise((_, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true })
      })
    })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(invocation(CHOICE, controller.signal))
    assert.equal(withdrawnBeforeHostSettled, true)
    assert.equal(questionSignal?.reason, CANCELLED)
    assert.deepEqual(result, { kind: 'error', text: CANCELLED_TEXT })
  })

  it('preserves post-commit facts when cancellation accompanies a route conflict', async () => {
    const controller = new AbortController()
    const stored = new Map<string, LoginAuthType>()
    const host = makeHost(async () => {
      stored.set(CHOICE.providerId, CHOICE.authType)
      controller.abort(CANCELLED)
      throw new StoredCredentialError(STORED_UNAVAILABLE)
    }, undefined, stored)
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(invocation(CHOICE, controller.signal))
    assert.equal(stored.get(CHOICE.providerId), CHOICE.authType)
    assert.deepEqual(result, { kind: 'error', text: STORED_UNAVAILABLE })
  })

  for (const cancelled of READBACK_CANCELLATION) {
    it('reports completed login when readback fails with cancellation ' + cancelled, async () => {
      const controller = new AbortController()
      const stored = new Map<string, LoginAuthType>()
      const host = makeHost(async () => {
        stored.set(CHOICE.providerId, CHOICE.authType)
        return 'present'
      }, undefined, stored)
      host.stored = async () => {
        if (cancelled) controller.abort(CANCELLED)
        throw new Error(READBACK_DETAIL)
      }
      const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(invocation(CHOICE, controller.signal))
      assert.equal(stored.get(CHOICE.providerId), CHOICE.authType)
      assert.deepEqual(result, { kind: 'error', text: READBACK_FAILURE })
    })
  }

  for (const choice of CHOICES) {
    it('preserves a returned durable ' + choice.authType + ' result after late cancellation', async () => {
      const controller = new AbortController()
      const stored = new Map<string, LoginAuthType>()
      const host = makeHost(async () => {
        stored.set(choice.providerId, choice.authType)
        controller.abort(CANCELLED)
        return 'present'
      }, undefined, stored)
      const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(invocation(choice, controller.signal))
      assert.equal(result.kind, 'success')
      assert.equal(stored.get(choice.providerId), choice.authType)
    })
  }
})
