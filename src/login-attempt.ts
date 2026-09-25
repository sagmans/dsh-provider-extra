/**
 * One attended sign-in, from the first question to the stored credential.
 *
 * pi-ai drives the flow and asks through its own interaction seam; every ask
 * becomes a question the session UI renders, and the page or device code is
 * held open as a question of its own so a flow that is waiting stays visible
 * and cancellable. The attempt owns the deadline, the notices, and the verdict
 * the command finally reports.
 *
 * @module dsh-provider-extra/login-attempt
 */

import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { renderEvent } from './codex-login.ts'
import type { RouteDeclaration } from './login-route.ts'
import { StoredCredentialError } from './login-contract.ts'
import type { LoginAuthType, LoginChoice, LoginCommandHost } from './login-contract.ts'
import { answerLabels, answerText } from './login-choice.ts'

/** Question ids belong to the caller; the answer echoes them back. */
const PROMPT_QUESTION_ID = 'prompt'
const NOTICE_QUESTION_ID = 'notice'

/**
 * Question id suffix declaring that the typed answer is a credential. The
 * question seam has no field for it, so the id carries the declaration: it is
 * the one caller-owned token that reaches a surface unchanged, and a surface
 * that knows the suffix hides the value instead of guessing from the wording.
 */
const SECRET_ID_SUFFIX = ':secret'

/** The id a secret prompt answers to, so its answer is never shown. */
const SECRET_PROMPT_QUESTION_ID = PROMPT_QUESTION_ID + SECRET_ID_SUFFIX

/** Answer labels this command owns, so a decision is never read as typed text. */
const DONE_LABEL = 'Done'
const CANCEL_LABEL = 'Cancel'

/**
 * Caveat rendered with a secret prompt. The answer reaches the provider that
 * issued the key and the credential store, never the model's context, but a
 * session UI can only show what the human types: saying so is the difference
 * between a choice and a trap.
 */
const SECRET_DETAIL = 'The value is stored in your credential store and sent only to this provider to be checked.'

/** Guidance added to a page or device-code question, where waiting is the task. */
const WAIT_DETAIL = 'Finish on that page, then choose Done. The sign-in completes by itself.'

/**
 * Said when the sign-in had to declare the route. The settings file grew an
 * entry on the human's behalf, and a configuration change they did not make is
 * one they must hear about.
 */
const DECLARED_ROUTE_NOTICE = ' The provider was added to the llm-pi-ai settings, so its models work now.'

/** Said when a configured route already carried the sign-in. */
const PRESENT_ROUTE_NOTICE = ' The credential is stored and the route reads it on its next request.'

/** A failed confirmation cannot imply that a completed host login rolled back. */
const READBACK_FAILURE_PREFIX = 'The sign-in completed, but credential readback failed: '

/**
 * Said when nothing here can serve the provider. A stored credential with no
 * route is the state that later fails a turn, so the failure belongs to the
 * sign-in that caused it rather than to a model request the human cannot explain.
 */
const UNAVAILABLE_ROUTE_NOTICE = ' Nothing in this composition serves its models: mount an llm-pi-ai service to use them.'

/** Upper bound on one attended attempt, longer than any device code lives. */
const ATTEMPT_DEADLINE_MS = 15 * 60_000

/** What one question turn needs from the running attempt. */
interface Attempt {
  /** Aborts the whole sign-in, whether the human declined or the clock ran out. */
  readonly abort: AbortController
  /** Caller cancellation and local cancellation must reach the same pending work. */
  readonly signal: AbortSignal
  /** Rendered notices so far, newest last. */
  readonly notices: string[]
  /** The question holding the page or device code open, while it is open. */
  wait: { abort: AbortController; settled: Promise<void> } | undefined
  /** Set when the human chose Cancel, so the failure reads as their decision. */
  declined: boolean
  /** Set when the deadline, not the human, ended the attempt. */
  expired: boolean
}

/** Close the waiting question, if one is open, and let its ask settle. */
async function closeWait(attempt: Attempt): Promise<void> {
  const open = attempt.wait
  attempt.wait = undefined
  if (open === undefined) return
  open.abort.abort()
  await open.settled
}

/**
 * Hold the page or device code open as a question while the flow waits for the
 * human. Answering Done needs no handling — the flow finishes on its own — so
 * only Cancel is read, and the question is withdrawn the moment the flow ends.
 */
function openWait(host: LoginCommandHost, invocation: CommandInvocation, choice: LoginChoice, attempt: Attempt): void {
  const abort = new AbortController()
  const asked = host.ask({
    agent: invocation.agent,
    questions: [{
      id: NOTICE_QUESTION_ID,
      header: choice.providerName,
      question: 'Finish signing in',
      detail: [...attempt.notices, WAIT_DETAIL].join('\n'),
      options: [{ label: DONE_LABEL }, { label: CANCEL_LABEL }],
    }],
    signal: AbortSignal.any([attempt.signal, abort.signal]),
  })
  const settled = asked.then((answer) => {
    if (answerLabels(answer, NOTICE_QUESTION_ID).includes(CANCEL_LABEL)) {
      attempt.declined = true
      attempt.abort.abort()
    }
  }, () => {
    // A withdrawn question is the normal end of an attempt: the flow settled
    // first, or the surface cannot ask. Either way the flow's own outcome rules.
  })
  attempt.wait = { abort, settled }
}

/** The question one pi-ai prompt becomes, so the human can answer it. */
function promptQuestion(prompt: AuthPrompt, choice: LoginChoice): AskUserQuestionItem {
  const header = choice.providerName
  switch (prompt.type) {
    case 'select':
      return {
        id: PROMPT_QUESTION_ID,
        header,
        question: prompt.message,
        options: prompt.options.map(option => ({
          label: option.label,
          ...option.description === undefined ? {} : { description: option.description },
        })),
      }
    case 'secret':
      return {
        id: SECRET_PROMPT_QUESTION_ID,
        header,
        question: prompt.message,
        detail: SECRET_DETAIL + (prompt.placeholder === undefined ? '' : ' ' + prompt.placeholder),
      }
    case 'manual_code':
      return {
        id: PROMPT_QUESTION_ID,
        header,
        question: prompt.message,
        detail: 'Answer here only if the browser did not finish the sign-in.'
          + (prompt.placeholder === undefined ? '' : ' ' + prompt.placeholder),
      }
    case 'text':
      return {
        id: PROMPT_QUESTION_ID,
        header,
        question: prompt.message,
        ...prompt.placeholder === undefined ? {} : { detail: prompt.placeholder },
      }
  }
}

/** The id the answer to one prompt echoes back, which declares a secret as one. */
function promptQuestionId(prompt: AuthPrompt): string {
  return prompt.type === 'secret' ? SECRET_PROMPT_QUESTION_ID : PROMPT_QUESTION_ID
}

/** Answer one pi-ai prompt through the session UI. */
async function askPrompt(
  host: LoginCommandHost,
  invocation: CommandInvocation,
  prompt: AuthPrompt,
  choice: LoginChoice,
  attempt: Attempt,
): Promise<string> {
  const questionId = promptQuestionId(prompt)
  const ask = host.ask({
    agent: invocation.agent,
    questions: [promptQuestion(prompt, choice)],
    signal: attempt.signal,
  })
  if (prompt.type === 'select') {
    const options = prompt.options
    const answer = await ask
    for (const label of answerLabels(answer, questionId)) {
      const hit = options.find(option => option.label === label)
      if (hit !== undefined) return hit.id
    }
    // A select answers with an option id, never a position: an answer that
    // names neither is echoed back only when it is an id pi-ai offered.
    const typed = answerText(answer, questionId)
    const byId = options.find(option => option.id === typed)
    if (byId !== undefined) return byId.id
    throw new Error('dsh-provider-extra: answer the sign-in question by choosing one of its options')
  }
  if (prompt.type === 'manual_code' && prompt.signal !== undefined) {
    // The code is optional by design: pi-ai races this prompt against the
    // browser callback and withdraws it when the callback wins. Waiting on
    // the withdrawal instead of demanding a code keeps the callback able to
    // finish the sign-in on its own.
    const withdrawn = new Promise<never>((_, reject) => {
      const lose = (): void => { reject(new Error('dsh-provider-extra: the browser completed the sign-in')) }
      if (prompt.signal?.aborted === true) {
        lose()
        return
      }
      prompt.signal?.addEventListener('abort', lose, { once: true })
    })
    const answer = await Promise.race([ask, withdrawn])
    const typed = answerText(answer, questionId)
    if (typed === undefined) throw new Error('dsh-provider-extra: no code was given')
    return typed
  }
  const answer = await ask
  const typed = answerText(answer, questionId)
  if (typed === undefined) throw new Error('dsh-provider-extra: the sign-in question was left unanswered')
  return typed
}

/** The interaction one attempt hands to pi-ai's login. */
function attemptInteraction(
  host: LoginCommandHost,
  invocation: CommandInvocation,
  choice: LoginChoice,
  attempt: Attempt,
): AuthInteraction {
  return {
    signal: attempt.signal,
    notify: (event: AuthEvent) => {
      attempt.notices.push(...renderEvent(event))
      if (attempt.wait === undefined) openWait(host, invocation, choice, attempt)
    },
    prompt: async (prompt: AuthPrompt) => {
      await closeWait(attempt)
      return await askPrompt(host, invocation, prompt, choice, attempt)
    },
  }
}

/** What one finished sign-in means, said in terms of whether its models can be reached. */
function successText(choice: LoginChoice, route: RouteDeclaration): string {
  const signedIn = 'Signed in to ' + choice.providerName + ' (' + choice.methodLabel + ').'
  if (route === 'declared') return signedIn + DECLARED_ROUTE_NOTICE
  if (route === 'unavailable') return signedIn + UNAVAILABLE_ROUTE_NOTICE
  return signedIn + PRESENT_ROUTE_NOTICE
}

/** Failed attempts must distinguish cancelled work from credentials already committed. */
function describeFailure(error: unknown, attempt: Attempt, choice: LoginChoice): string {
  if (error instanceof StoredCredentialError) return error.message
  if (attempt.declined || (attempt.signal.aborted && !attempt.expired)) return 'The ' + choice.providerName + ' sign-in was cancelled.'
  if (attempt.expired) return 'The ' + choice.providerName + ' sign-in timed out; start it again to get a fresh code.'
  const message = error instanceof Error ? error.message : String(error)
  return 'The ' + choice.providerName + ' sign-in failed: ' + message
}

/** Run one sign-in end to end: the conversation plus the stored-credential check. */
export async function runChoice(
  host: LoginCommandHost,
  invocation: CommandInvocation,
  choice: LoginChoice,
): Promise<CommandResult> {
  const abort = new AbortController()
  const attempt: Attempt = {
    abort,
    signal: AbortSignal.any([invocation.signal, abort.signal]),
    notices: [],
    wait: undefined,
    declined: false,
    expired: false,
  }
  const deadline = setTimeout(() => {
    attempt.expired = true
    attempt.abort.abort()
  }, ATTEMPT_DEADLINE_MS)
  if (typeof deadline === 'object') deadline.unref()
  try {
    attempt.signal.throwIfAborted()
    const route = await host.login(choice, attemptInteraction(host, invocation, choice, attempt))
    // A resolved host may already have committed credentials; late cancellation cannot undo them.
    await closeWait(attempt)
    // pi-ai persists during login, so resolving is not yet proof: only a
    // record read back is. A flow that resolves without one is a catalog bug
    // the human must hear about rather than a silent no-op sign-in.
    let stored: LoginAuthType | undefined
    try {
      stored = await host.stored(choice.providerId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new StoredCredentialError(READBACK_FAILURE_PREFIX + message, { cause: error })
    }
    if (stored === undefined) {
      return {
        kind: 'error',
        text: 'The ' + choice.providerName + ' sign-in reported success but stored no credential; nothing changed.',
      }
    }
    return { kind: 'success', text: successText(choice, route) }
  } catch (error) {
    return { kind: 'error', text: describeFailure(error, attempt, choice) }
  } finally {
    clearTimeout(deadline)
    await closeWait(attempt)
  }
}
