/**
 * What each provider authenticates with right now.
 *
 * A stored record and a configured route answer different questions, and a
 * human asking for status means the one that decides whether their next turn
 * works: the reference the route resolves, or the credential the sign-in
 * stored. Reporting only the record once hid exactly the state that fails a
 * turn, so the reference is read first.
 *
 * @module dsh-provider-extra/login-status
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { LoginChoice, LoginCommandHost } from './login-contract.ts'

/** How one provider authenticates right now, as the human should read it. */
async function statusLine(host: LoginCommandHost, choice: LoginChoice): Promise<string> {
  const reference = await host.reference(choice.providerId)
  if (reference !== undefined) {
    const where = reference.source === undefined ? 'not set' : `set from ${reference.source}`
    return `  ${choice.providerName} — API key ${reference.ref} (${where})`
  }
  const stored = await host.stored(choice.providerId)
  return (
    '  ' +
    choice.providerName +
    ' — ' +
    (stored === undefined ? 'not signed in' : `signed in (${stored})`)
  )
}

/** Answer how each provider authenticates today. */
export async function statusOf(host: LoginCommandHost): Promise<CommandResult> {
  const choices = host.choices()
  if (choices.length === 0) {
    return {
      kind: 'error',
      text: 'dsh-provider-extra: this composition mounts no provider with an interactive sign-in',
    }
  }
  const seen = new Set<string>()
  const lines: string[] = []
  for (const choice of choices) {
    if (seen.has(choice.providerId)) continue
    seen.add(choice.providerId)
    lines.push(await statusLine(host, choice))
  }
  return { kind: 'success', text: ['Provider sign-in status:', ...lines].join('\n') }
}
