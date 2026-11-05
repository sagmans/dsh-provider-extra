/**
 * The sign-in command against fakes: the host stands in for the catalog and
 * the login flow, and the UI double answers the questions a human would,
 * including the ones that only a race can end.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { createLoginCommand, DEFAULT_LOGIN_COMMAND_NAME } from '../src/login-command.ts'
import type {
  DeclaredReference,
  LoginAuthType,
  LoginChoice,
  LoginCommandHost,
} from '../src/login-contract.ts'
import type { RouteDeclaration } from '../src/login-route.ts'
import { must } from './must.ts'

/** The registry knows the agent contract; deriving it keeps this suite free of a host dependency. */
type AgentHandle = Parameters<CommandRuntime['list']>[0]

/** What the command hands the session UI. */
type AskRequest = Parameters<LoginCommandHost['ask']>[0]

const CODEX: LoginChoice = {
  providerId: 'openai-codex',
  providerName: 'ChatGPT (Codex)',
  authType: 'oauth',
  methodLabel: 'Sign in with ChatGPT',
}
const ANTHROPIC_SUBSCRIPTION: LoginChoice = {
  providerId: 'anthropic',
  providerName: 'Anthropic',
  authType: 'oauth',
  methodLabel: 'Anthropic (Claude Pro/Max)',
}
const ANTHROPIC_KEY: LoginChoice = {
  providerId: 'anthropic',
  providerName: 'Anthropic',
  authType: 'api_key',
  methodLabel: 'Anthropic API key',
}
const CHOICES = [CODEX, ANTHROPIC_SUBSCRIPTION, ANTHROPIC_KEY]

/** One answer a scripted UI gives when asked: a fixed answer, or a reaction to the request. */
type ScriptedAnswer =
  | AskUserQuestionAnswer
  | ((request: AskRequest) => AskUserQuestionAnswer | Promise<AskUserQuestionAnswer>)

/** The session UI as a script: every question is recorded and answered in turn. */
class FakeUi {
  readonly questions: AskUserQuestionItem[] = []
  readonly signals: (AbortSignal | undefined)[] = []
  private readonly script: ScriptedAnswer[]

  constructor(script: ScriptedAnswer[]) {
    this.script = [...script]
  }

  readonly ask = async (request: AskRequest): Promise<AskUserQuestionAnswer> => {
    const question = request.questions[0]
    assert.notEqual(question, undefined, 'the command asked no question')
    this.questions.push(question as AskUserQuestionItem)
    this.signals.push(request.signal)
    const next = this.script.shift()
    if (next === undefined) throw new Error(`unexpected question: ${String(question?.question)}`)
    return typeof next === 'function' ? await next(request) : next
  }

  /** Questions still unanswered, as a failed expectation reads better than a hang. */
  get pending(): number {
    return this.script.length
  }
}

/** An answer that picks labels for one question id. */
function picks(id: string, ...labels: string[]): AskUserQuestionAnswer {
  return { answers: [{ id, selected: labels }] }
}

/** An answer that types free text for one question id. */
function types(id: string, custom: string): AskUserQuestionAnswer {
  return { answers: [{ id, selected: [], custom }] }
}

/** The label the picker shows for one choice. */
function pickerLabel(_ui: FakeUi, label: string): ScriptedAnswer {
  return (request) => {
    const options = request.questions[0]?.options ?? []
    assert.ok(
      options.some((option) => option.label === label),
      `no option labelled ${label}`,
    )
    return picks(request.questions[0]?.id ?? '', label)
  }
}

/** An answer that stays pending until the question is withdrawn. */
function waitsForWithdrawal(seen: { aborted?: boolean }): ScriptedAnswer {
  return (request) =>
    new Promise<AskUserQuestionAnswer>((_, reject) => {
      const signal = request.signal
      if (signal === undefined) {
        reject(new Error('the waiting question carried no signal'))
        return
      }
      signal.addEventListener(
        'abort',
        () => {
          seen.aborted = true
          reject(new Error('withdrawn'))
        },
        { once: true },
      )
    })
}

/** A host over the given choices and UI, recording every sign-in it runs. */
function makeHost(
  ui: FakeUi,
  options: {
    choices?: readonly LoginChoice[]
    login?: (choice: LoginChoice, interaction: AuthInteraction) => Promise<void>
    stored?: Map<string, LoginAuthType>
    /** Declared route references the composition resolves, for the status view. */
    references?: Map<string, DeclaredReference>
    /** A flow that resolves without persisting is the case the command must catch. */
    persist?: boolean
    /** What the route declaration found, so each notice can be asserted. */
    route?: RouteDeclaration
  } = {},
): { host: LoginCommandHost; logins: LoginChoice[]; stored: Map<string, LoginAuthType> } {
  const logins: LoginChoice[] = []
  const stored = options.stored ?? new Map<string, LoginAuthType>()
  const persist = options.persist ?? true
  const host: LoginCommandHost = {
    choices: () => options.choices ?? CHOICES,
    login: async (choice, interaction) => {
      logins.push(choice)
      if (options.login !== undefined) await options.login(choice, interaction)
      if (persist) stored.set(choice.providerId, choice.authType)
      return options.route ?? 'present'
    },
    stored: async (providerId) => stored.get(providerId),
    reference: async (providerId) => options.references?.get(providerId),
    ask: ui.ask,
  }
  return { host, logins, stored }
}

/** A command invocation carrying raw input, as the registry would derive it. */
function invocation(rawInput: string): CommandInvocation {
  return {
    commandId: 'command-1',
    agent: { id: 'agent-1' },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  } as unknown as CommandInvocation
}

describe('provider sign-in command', () => {
  it('asks for a provider and runs the pick through pi-ai', async () => {
    const ui = new FakeUi([pickerLabel(new FakeUi([]), 'ChatGPT (Codex)')])
    const { host, logins, stored } = makeHost(ui)
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation(''),
    )
    assert.equal(result.kind, 'success')
    assert.match(
      result.kind === 'success' ? (result.text ?? '') : '',
      /Signed in to ChatGPT \(Codex\)/,
    )
    assert.deepEqual(
      logins.map((choice) => [choice.providerId, choice.authType]),
      [['openai-codex', 'oauth']],
    )
    assert.equal(stored.get('openai-codex'), 'oauth')
  })

  it('says when the sign-in had to declare the route, because the settings file changed for them', async () => {
    const ui = new FakeUi([pickerLabel(new FakeUi([]), 'ChatGPT (Codex)')])
    const { host } = makeHost(ui, { route: 'declared' })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation(''),
    )
    assert.match(
      result.kind === 'success' ? (result.text ?? '') : '',
      /added to the llm-pi-ai settings/,
    )
  })

  it('says when nothing can serve the provider instead of promising a route', async () => {
    const ui = new FakeUi([pickerLabel(new FakeUi([]), 'ChatGPT (Codex)')])
    const { host } = makeHost(ui, { route: 'unavailable' })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation(''),
    )
    assert.match(result.kind === 'success' ? (result.text ?? '') : '', /mount an llm-pi-ai service/)
  })

  it('disambiguates a provider that offers both a subscription and a key, naming each method once', async () => {
    const ui = new FakeUi([
      (request) => {
        const labels = (request.questions[0]?.options ?? []).map((option) => option.label)
        assert.deepEqual(labels, [
          'ChatGPT (Codex)',
          'Anthropic (Claude Pro/Max)',
          'Anthropic API key',
        ])
        return picks(request.questions[0]?.id ?? '', 'Anthropic API key')
      },
    ])
    const { host, logins } = makeHost(ui)
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation(''),
    )
    assert.equal(result.kind, 'success')
    assert.deepEqual(
      logins.map((choice) => [choice.providerId, choice.authType]),
      [['anthropic', 'api_key']],
    )
  })

  it('skips the picker when the input names a provider, and the method word chooses', async () => {
    const ui = new FakeUi([])
    const { host, logins } = makeHost(ui)
    const command = createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME)
    await command.handler(invocation('anthropic key'))
    await command.handler(invocation('anthropic'))
    assert.equal(ui.questions.length, 0)
    assert.deepEqual(
      logins.map((choice) => choice.authType),
      ['api_key', 'oauth'],
    )
  })

  it('refuses an unknown provider without starting a flow', async () => {
    const ui = new FakeUi([])
    const { host, logins } = makeHost(ui)
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation('nope'),
    )
    assert.equal(result.kind, 'error')
    assert.match(result.text, /no sign-in named "nope"/)
    assert.match(result.text, /openai-codex, anthropic/)
    assert.equal(logins.length, 0)
  })

  it('reports what is stored per provider', async () => {
    const ui = new FakeUi([])
    const { host } = makeHost(ui, {
      stored: new Map<string, LoginAuthType>([['openai-codex', 'oauth']]),
    })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation('status'),
    )
    const text = result.kind === 'success' ? (result.text ?? '') : ''
    assert.match(text, /ChatGPT \(Codex\) — signed in \(oauth\)/)
    assert.match(text, /Anthropic — not signed in/)
  })

  it('reports a declared route reference as what that provider authenticates with', async () => {
    const ui = new FakeUi([])
    const { host } = makeHost(ui, {
      stored: new Map<string, LoginAuthType>([['openai-codex', 'oauth']]),
      references: new Map<string, DeclaredReference>([
        ['anthropic', { ref: 'ANTHROPIC_API_KEY', source: 'file' }],
      ]),
    })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation('status'),
    )
    const text = result.kind === 'success' ? (result.text ?? '') : ''
    assert.match(text, /Anthropic — API key ANTHROPIC_API_KEY \(set from file\)/)
    assert.match(text, /ChatGPT \(Codex\) — signed in \(oauth\)/)
  })

  it('names a declared route reference nothing supplies, because that route cannot authenticate', async () => {
    const ui = new FakeUi([])
    const { host } = makeHost(ui, {
      references: new Map<string, DeclaredReference>([['anthropic', { ref: 'ANTHROPIC_API_KEY' }]]),
    })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation('status'),
    )
    const text = result.kind === 'success' ? (result.text ?? '') : ''
    assert.match(text, /Anthropic — API key ANTHROPIC_API_KEY \(not set\)/)
  })

  it('holds a device code open and withdraws the question when the flow settles', async () => {
    const seen: { aborted?: boolean } = {}
    const ui = new FakeUi([waitsForWithdrawal(seen)])
    const { host } = makeHost(ui, {
      login: async (_choice, interaction) => {
        interaction.notify({
          type: 'device_code',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://example.test/device',
        })
        await new Promise((resolve) => setTimeout(resolve, 10))
      },
    })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation('openai-codex'),
    )
    assert.equal(result.kind, 'success')
    const detail = ui.questions[0]?.detail ?? ''
    assert.match(detail, /ABCD-EFGH/)
    assert.match(detail, /https:\/\/example\.test\/device/)
    assert.equal(seen.aborted, true, 'the code question outlived the sign-in')
  })

  it('answers a select prompt with the option id the label names', async () => {
    const ui = new FakeUi([pickerLabel(new FakeUi([]), 'Device code')])
    const answered: string[] = []
    const { host } = makeHost(ui, {
      login: async (_choice, interaction) => {
        answered.push(
          await interaction.prompt({
            type: 'select',
            message: 'How do you want to sign in?',
            options: [
              { id: 'browser', label: 'Browser' },
              { id: 'device_code', label: 'Device code' },
            ],
          }),
        )
      },
    })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation('openai-codex'),
    )
    assert.equal(result.kind, 'success')
    assert.deepEqual(answered, ['device_code'])
  })

  it('returns typed text and declares a secret by its question id', async () => {
    const ui = new FakeUi([types('prompt:secret', 'sk-test-key')])
    const answered: string[] = []
    const { host } = makeHost(ui, {
      login: async (_choice, interaction) => {
        answered.push(await interaction.prompt({ type: 'secret', message: 'Paste the API key' }))
      },
    })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation('anthropic key'),
    )
    assert.equal(result.kind, 'success', result.kind === 'error' ? result.text : '')
    assert.deepEqual(answered, ['sk-test-key'])
    assert.equal(ui.questions[0]?.id, 'prompt:secret')
    assert.match(ui.questions[0]?.detail ?? '', /sent only to this provider/)
  })

  it('answers a plain prompt under the id that declares nothing', async () => {
    const ui = new FakeUi([types('prompt', 'a value anyone may read')])
    const answered: string[] = []
    const { host } = makeHost(ui, {
      login: async (_choice, interaction) => {
        answered.push(await interaction.prompt({ type: 'text', message: 'Which workspace?' }))
      },
    })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation('anthropic key'),
    )
    assert.equal(result.kind, 'success', result.kind === 'error' ? result.text : '')
    assert.deepEqual(answered, ['a value anyone may read'])
    assert.equal(ui.questions[0]?.id, 'prompt')
  })

  it('lets a browser callback win the manual-code race', async () => {
    const controller = new AbortController()
    const ui = new FakeUi([waitsForWithdrawal({})])
    const outcome: string[] = []
    const { host } = makeHost(ui, {
      login: async (_choice, interaction) => {
        setTimeout(() => {
          controller.abort()
        }, 5)
        try {
          await interaction.prompt({
            type: 'manual_code',
            message: 'Paste the code',
            signal: controller.signal,
          })
          outcome.push('answered')
        } catch {
          outcome.push('withdrawn')
        }
      },
    })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation('openai-codex'),
    )
    assert.equal(result.kind, 'success')
    assert.deepEqual(outcome, ['withdrawn'])
  })

  it('cancels the attempt when the human picks Cancel on the code question', async () => {
    const ui = new FakeUi([
      (request) => {
        const labels = (request.questions[0]?.options ?? []).map((option) => option.label)
        return picks(
          request.questions[0]?.id ?? '',
          labels.includes('Cancel') ? 'Cancel' : (labels[0] ?? ''),
        )
      },
    ])
    const { host } = makeHost(ui, {
      login: async (_choice, interaction) => {
        interaction.notify({
          type: 'device_code',
          userCode: 'WXYZ-1234',
          verificationUri: 'https://example.test/device',
        })
        await new Promise((_, reject) => {
          interaction.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'))
            },
            { once: true },
          )
        })
      },
    })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation('openai-codex'),
    )
    assert.equal(result.kind, 'error')
    assert.match(result.text, /was cancelled/)
  })

  it('reports a cancelled picker instead of starting a flow', async () => {
    const ui = new FakeUi([
      () => {
        throw new Error('ASK_ABORTED')
      },
    ])
    const { host, logins } = makeHost(ui)
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation(''),
    )
    assert.equal(result.kind, 'error')
    assert.match(result.text, /no provider was picked/)
    assert.equal(logins.length, 0)
  })

  it('refuses to call a sign-in done when nothing was stored', async () => {
    const ui = new FakeUi([])
    const { host } = makeHost(ui, { persist: false })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation('openai-codex'),
    )
    assert.equal(result.kind, 'error')
    assert.match(result.text, /stored no credential/)
  })

  it('offers no sign-in when the composition mounts none', async () => {
    const ui = new FakeUi([])
    const { host } = makeHost(ui, { choices: [] })
    const result = await createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME).handler(
      invocation(''),
    )
    assert.equal(result.kind, 'error')
    assert.match(result.text, /no provider with an interactive sign-in/)
  })

  it('keeps sign-in input out of the session log', async () => {
    const ui = new FakeUi([])
    const { host } = makeHost(ui)
    const definition: CommandDefinition = createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME)
    assert.equal(definition.recordInput, false)
    assert.ok(definition.description.length > 0)
  })
})

describe('provider sign-in command in the harness registry', () => {
  it('registers, lists, and resolves through CommandRuntime', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(CommandRuntime)
    try {
      const ui = new FakeUi([])
      const { host } = makeHost(ui)
      const dispose = ctx.commands.register(createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME))
      const agent = { id: 'agent-test' } as unknown as AgentHandle

      const listed = ctx.commands
        .list(agent)
        .find((descriptor) => descriptor.name === DEFAULT_LOGIN_COMMAND_NAME)
      assert.notEqual(listed, undefined)
      assert.ok(must(listed).description.length > 0)
      assert.ok((must(listed).input?.hint ?? '').length > 0)

      const found = ctx.commands.find(agent, DEFAULT_LOGIN_COMMAND_NAME)
      assert.notEqual(found, undefined)
      const result = await must(found).handler(invocation('openai-codex'))
      assert.equal(result.kind, 'success')

      dispose()
      assert.equal(ctx.commands.find(agent, DEFAULT_LOGIN_COMMAND_NAME), undefined)
    } finally {
      await fiber.dispose()
    }
  })
})
