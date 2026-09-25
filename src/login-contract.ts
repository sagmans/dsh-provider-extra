/**
 * The vocabulary the sign-in command and the conversation it runs share.
 *
 * The command flow, the catalog picker, the pi-ai attempt, and the status
 * answer all read the same few shapes; each module depends on this contract
 * rather than on the others, so none of them owns another's interface.
 *
 * @module dsh-provider-extra/login-contract
 */

import type { AuthInteraction } from '@earendil-works/pi-ai'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { RouteDeclaration } from './login-route.ts'

/** Post-commit facts must remain visible even when cancellation or a deadline also wins. */
export class StoredCredentialError extends Error {}

/** pi-ai's auth type ids: a subscription login, or a stored API key. */
export type LoginAuthType = 'oauth' | 'api_key'

/** One provider-and-method pair as the picker shows it. */
export interface LoginChoice {
  /** pi-ai catalog id, echoed back when the flow runs. */
  providerId: string
  /** Provider name a human recognizes. */
  providerName: string
  /** Which method this choice runs. */
  authType: LoginAuthType
  /** Method label, e.g. "Sign in with ChatGPT" or "Anthropic API key". */
  methodLabel: string
}

/**
 * One declared route's credential reference and whether anything supplies it.
 * The reference decides its route on its own: llm-pi-ai resolves the named
 * value before it ever reaches the credential store, so an unset reference
 * beside a signed-in record is not what that route uses.
 */
export interface DeclaredReference {
  /** Environment-reference name the route resolves, e.g. `KIMI_CODING_API_KEY`. */
  ref: string
  /** Credential layer currently supplying the value, absent while nothing does. */
  source?: string
}

/** What the command needs from its plugin. */
export interface LoginCommandHost {
  /** Every provider in this composition that offers an interactive sign-in. */
  choices(): readonly LoginChoice[]
  /** Run one sign-in to completion; the credential commit and its route declaration happen inside. */
  login(choice: LoginChoice, interaction: AuthInteraction): Promise<RouteDeclaration>
  /** The stored credential kind for one provider, absent when nothing is stored. */
  stored(providerId: string): Promise<LoginAuthType | undefined>
  /**
   * The credential reference one provider's declared route resolves, when it
   * names one — configured or not, because a route whose reference is unset is
   * the state that fails its next turn.
   */
  reference(providerId: string): Promise<DeclaredReference | undefined>
  /** Ask the session UI, a surface that may be missing in headless compositions. */
  ask(request: {
    agent: CommandInvocation['agent']
    questions: AskUserQuestionItem[]
    signal?: AbortSignal
  }): Promise<AskUserQuestionAnswer>
}
