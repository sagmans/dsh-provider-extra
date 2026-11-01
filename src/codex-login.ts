/**
 * Terminal sign-in for the Codex subscription route.
 *
 * This is the other half of the seam DSH core leaves unconnected: it drives
 * pi-ai's own Codex OAuth login (browser or device-code, chosen at the
 * prompt) against the harness credential store, so the grant lands in the
 * same record the route reads. It runs as the package bin (src/login-cli.ts),
 * not inside the server, because a sign-in is an attended one-off: it needs a
 * human watching for the URL and code.
 *
 * @module dsh-provider-extra/codex-login
 */

import type { Interface } from 'node:readline/promises'
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import { CODEX_CATALOG_ID } from './codex.ts'

/** pi-ai auth type id for the subscription login. */
const OAUTH_TYPE = 'oauth'

/** What the runner needs from its host: line input, line output, abort. */
export interface LoginTerminal {
  /** Read one line answering the rendered prompt. */
  question(prompt: string): Promise<string>
  /** Show one output line. */
  print(line: string): void
  /** Abort signal for the whole attempt (SIGINT in the script). */
  signal: AbortSignal
}

/** A pi-ai Models collection narrowed to the two members the login uses. */
export interface LoginModels {
  setProvider(provider: unknown): void
  login(providerId: string, type: string, interaction: AuthInteraction): Promise<unknown>
}

/** Render one pi-ai login event as terminal output lines. */
export function renderEvent(event: AuthEvent): string[] {
  switch (event.type) {
    case 'info': {
      const link = event.links?.[0]
      return [event.message + (link === undefined ? '' : ` ${link.url}`)]
    }
    case 'auth_url':
      return [event.instructions ?? 'Open this page to continue signing in:', event.url]
    case 'device_code':
      return [
        'Enter this code on the verification page to finish signing in:',
        `  URL:  ${event.verificationUri}`,
        `  Code: ${event.userCode}`,
      ]
    case 'progress':
      return [event.message]
  }
}

/** Render one pi-ai prompt as the terminal question to ask. */
export function renderPrompt(prompt: AuthPrompt): {
  question: string
  options?: readonly { id: string; label: string }[]
} {
  switch (prompt.type) {
    case 'select': {
      const choices = prompt.options
        .map((option, index) => `${index + 1}) ${option.label}`)
        .join(' | ')
      return {
        question: `${prompt.message} ${choices} — answer 1-${prompt.options.length} or id: `,
        options: prompt.options,
      }
    }
    case 'secret':
    case 'text':
    case 'manual_code': {
      const hint = prompt.placeholder === undefined ? '' : ` (${prompt.placeholder})`
      return { question: `${prompt.message + hint} ` }
    }
  }
}

/**
 * Answer one pi-ai prompt from the terminal. A select resolves the option
 * id, never the position: pi-ai matches on id, and echoing the position back
 * would sign into whatever drifts into that slot next.
 */
export async function answerPrompt(terminal: LoginTerminal, prompt: AuthPrompt): Promise<string> {
  const rendered = renderPrompt(prompt)
  if (rendered.options !== undefined) {
    const options = rendered.options
    const raw = await terminal.question(rendered.question)
    const picked = Number.parseInt(raw.trim(), 10)
    if (Number.isInteger(picked) && picked >= 1 && picked <= options.length) {
      const option = options[picked - 1]
      if (option !== undefined) return option.id
    }
    const byId = options.find((option) => option.id === raw.trim())
    if (byId !== undefined) return byId.id
    throw new Error(
      'dsh-provider-extra: answer the prompt with a number 1-' +
        String(options.length) +
        ' or an option id',
    )
  }
  return terminal.question(rendered.question)
}

/**
 * The terminal as a pi-ai AuthInteraction. Prompt withdrawal (the
 * manual_code race against the local callback server) surfaces as a
 * rejection, which is exactly what pi-ai's login expects from a lost race.
 */
export function terminalInteraction(terminal: LoginTerminal): AuthInteraction {
  return {
    signal: terminal.signal,
    notify: (event) => {
      for (const line of renderEvent(event)) terminal.print(line)
    },
    prompt: (prompt) => answerPrompt(terminal, prompt),
  }
}

/**
 * Run the Codex OAuth login to completion against an already-built Models
 * collection. The collection carries the harness-backed store, so pi-ai
 * persists the grant itself; this function only conducts the conversation.
 *
 * The interaction is a parameter rather than a terminal because the attended
 * sign-in has two hosts: the package bin with a human at a prompt, and the
 * server-side command handler, which announces the page and then waits without
 * any terminal at all.
 *
 * @param models - collection holding the catalog Codex provider and the harness store.
 * @param provider - the catalog Codex provider object to sign in with.
 * @param interaction - pi-ai callbacks for this attempt.
 */
export async function startCodexLogin(
  models: LoginModels,
  provider: unknown,
  interaction: AuthInteraction,
): Promise<void> {
  models.setProvider(provider)
  await models.login(CODEX_CATALOG_ID, OAUTH_TYPE, interaction)
}

/**
 * Conduct the terminal sign-in: the same attempt, driven by readline, plus one
 * closing line. Secrets stay out of output: success names the provider, never
 * the tokens.
 *
 * @param models - collection holding the catalog Codex provider and the harness store.
 * @param provider - the catalog Codex provider object to sign in with.
 * @param terminal - line I/O for the human attending the sign-in.
 */
export async function runCodexLogin(
  models: LoginModels,
  provider: unknown,
  terminal: LoginTerminal,
): Promise<void> {
  await startCodexLogin(models, provider, terminalInteraction(terminal))
  terminal.print(
    'Signed in to OpenAI Codex. The subscription grant is stored; the route serves it with no restart.',
  )
}

/** A readline-backed terminal over stdin/stdout. */
export function readlineTerminal(rl: Interface, signal: AbortSignal): LoginTerminal {
  return {
    question: (prompt) => rl.question(prompt),
    print: (line) => {
      console.log(line)
    },
    signal,
  }
}
