/**
 * Provider sign-in from the command palette.
 *
 * The command palette is the only surface a registry install reliably has — a
 * package bin is not on PATH and the tree it resolves through only exists
 * after a boot — so the attended sign-in lives where the human already is. It
 * is deliberately provider-agnostic: the host hands it every installed
 * provider that ships an interactive login, and the command runs whichever
 * one the human picks through pi-ai's own flow, so a new provider in the
 * catalog needs no change here.
 *
 * A sign-in is a conversation, and a command result renders only once the
 * handler settles. The conversation therefore runs through the session UI's
 * question channel: the provider picker, every flow prompt, and the page or
 * device code are asked as questions, and the handler answers with the final
 * verdict only after the credential is stored and observed. This module owns
 * the command itself; the vocabulary, the picker, the attempt, and the status
 * answer each live in their own module.
 *
 * @module dsh-provider-extra/login-command
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { LoginChoice, LoginCommandHost } from './login-contract.ts'
import { KEY_WORD, OAUTH_WORD, answerText, choiceByWords, pickerQuestion, resolveChoice, words } from './login-choice.ts'
import { runChoice } from './login-attempt.ts'
import { statusOf } from './login-status.ts'

/** Command name a profile gets unless it renames the command. */
export const DEFAULT_LOGIN_COMMAND_NAME = 'dsh-provider-extra-login'

/** Input word showing what is already stored instead of starting a sign-in. */
const STATUS_WORD = 'status'

/**
 * Build the provider sign-in command.
 *
 * @param host - the composition's providers, its login runner, and the session UI.
 * @param commandName - registered name, without the leading slash.
 * @returns the registry definition, valid until the profile unloads it.
 */
export function createLoginCommand(host: LoginCommandHost, commandName: string): CommandDefinition {
  const usage = 'Usage: /' + commandName + ' [<provider-id> [' + OAUTH_WORD + '|' + KEY_WORD + '] | ' + STATUS_WORD + ']'

  return {
    name: commandName,
    description: 'Sign in to a model provider (subscription or API key)',
    input: { hint: 'no input picks a provider, ' + STATUS_WORD + ' lists what is signed in' },
    // The input is a provider id in normal use, but this command is also the
    // one place a human might paste a key: keep the session log out of it.
    recordInput: false,
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const input = words(invocation.rawInput)
      if (input.length === 1 && input[0]?.toLowerCase() === STATUS_WORD) return await statusOf(host)
      if (input.length > 2) return { kind: 'error', text: 'dsh-provider-extra: too many arguments. ' + usage }
      const choices = host.choices()
      if (choices.length === 0) {
        return { kind: 'error', text: 'dsh-provider-extra: this composition mounts no provider with an interactive sign-in' }
      }
      const unknownChoice = (input: readonly string[]): CommandResult => {
        const known = [...new Set(choices.map(entry => entry.providerId))].join(', ')
        return { kind: 'error', text: 'dsh-provider-extra: no sign-in named "' + input.join(' ') + '". Known providers: ' + known + '. ' + usage }
      }
      let choice: LoginChoice | undefined
      if (input.length === 0) {
        try {
          const question = pickerQuestion(choices)
          const answer = await host.ask({
            agent: invocation.agent,
            questions: [question],
            signal: invocation.signal,
          })
          choice = resolveChoice(choices, answer)
          const typed = answerText(answer, question.id)
          if (choice === undefined && typed !== undefined) return unknownChoice(words(typed))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: 'dsh-provider-extra: no provider was picked (' + message + '). ' + usage }
        }
        if (choice === undefined) return { kind: 'error', text: 'dsh-provider-extra: no provider was picked. ' + usage }
      } else {
        choice = choiceByWords(choices, input)
        if (choice === undefined) return unknownChoice(input)
      }
      return await runChoice(host, invocation, choice)
    },
  }
}
