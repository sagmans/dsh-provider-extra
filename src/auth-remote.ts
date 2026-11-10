/**
 * Sign-in transport for the Models page, over the harness authorization seam.
 *
 * DSH core owns the flows (pi-ai's Codex OAuth among them) but no shipped
 * surface starts one. This adapter carries a single interactive attempt to the
 * browser half: it lists the flows, buffers their notices and questions, and
 * hands out frames by cursor. Polling keeps the Host contract to unary
 * invocations, so the plugin needs no generated stream descriptors.
 *
 * Markdown-free by design: the seam validates the credential commit, and this
 * module never reads a token, never logs an answer, and never decides that a
 * sign-in succeeded on its own.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKeyId } from '@deepseek-ai/dsh-credentials'
import {
  AUTH_CONTRIBUTION,
  AUTH_NAMESPACE,
  AUTH_PACKAGE,
  type AuthEntry,
  type AuthEvent,
  type AuthPoll,
  type AuthStart,
} from './tier-client.ts'

/** A page that closes mid-login must not keep its credential key claimed until restart. */
const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000
/** A finished attempt stays addressable so a panel opened around the settlement can read it. */
const SETTLED_RETENTION_MS = 2 * 60 * 1000
/** Retained attempts stay bounded so abandoned tabs cannot grow Host memory. */
const MAX_ATTEMPTS = 16
/** A real sign-in emits a handful of frames; the bound is a corruption guard. */
const MAX_EVENTS = 128
/** Matches the wire bound; the client enforces the same limit on its input. */
const MAX_ANSWER = 8_192
/** A provider failure may quote a response body; one bounded line is all a panel shows. */
const MAX_FAILURE = 512
const NO_FLOW = 'This provider has no sign-in flow in the installed harness'
const ALREADY_RUNNING = 'A sign-in for this provider is already running'
const UNKNOWN_ATTEMPT = 'This sign-in attempt is no longer available'
const UNKNOWN_PROMPT = 'That question is no longer waiting'
const ANSWER_TOO_LONG = 'The sign-in answer is too long'
const CANCELLED = 'The sign-in attempt was cancelled'
const TIMED_OUT = 'The sign-in attempt timed out'

/** The flow view the seam exposes; structural so adapter versions stay decoupled. */
interface FlowView {
  readonly key: string
  readonly label: string
  readonly methods: readonly { readonly id: string }[]
  readonly inFlight: boolean
}

/** Instructions a flow wants the human to see. */
interface SeamNotice {
  readonly message: string
  readonly url?: string
  readonly code?: string
}

/** A question a flow waits on. */
interface SeamPrompt {
  readonly kind: 'text' | 'secret' | 'select'
  readonly message: string
  readonly placeholder?: string
  readonly options?: readonly {
    readonly id: string
    readonly label: string
    readonly description?: string
  }[]
  readonly signal?: AbortSignal
}

/** The two callbacks one attempt talks through. */
interface SeamInteraction {
  notify(notice: SeamNotice): void
  prompt(prompt: SeamPrompt): Promise<string>
}

/** The part of `ctx.authorization` this transport uses. */
interface AuthorizationSeam {
  list(): readonly FlowView[]
  begin(request: {
    key: string
    method?: string
    signal: AbortSignal
    interaction: SeamInteraction
  }): Promise<{ status: 'authorized' | 'cancelled' }>
}

/** Record presence for a flow key; values never cross this module. */
interface CredentialsPort {
  describeRecord(key: never): Promise<{ configured: boolean }>
}

/** Typert registration port, as the tier transport uses it. */
interface TypertPort {
  register(contribution: typeof HOST_CONTRIBUTION): () => Promise<void>
}

/** One waiting question with the promise half an answer resolves and its listener cleanup. */
interface Pending {
  resolve(value: string): void
  reject(reason: unknown): void
  detach?: () => void
}

/** One attempt's buffered transport state. */
interface Attempt {
  readonly id: string
  readonly key: string
  readonly controller: AbortController
  readonly events: AuthEvent[]
  readonly prompts: Map<string, Pending>
  settled: boolean
  nextPrompt: number
  timeout: ReturnType<typeof setTimeout> | undefined
  retention: ReturnType<typeof setTimeout> | undefined
}

/** One line a panel may show for a failure, with control characters removed. */
function failureLine(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const line = raw
    .replaceAll(/\s+/gu, ' ')
    .replaceAll(/[\p{Cc}]/gu, '')
    .trim()
  if (line.length === 0) return 'Sign-in failed.'
  if (line.length <= MAX_FAILURE) return line
  return `${line.slice(0, MAX_FAILURE)}…`
}

/** Project a seam notice; absent members stay absent on the wire. */
function noticeEvent(notice: SeamNotice): AuthEvent {
  return {
    type: 'notice',
    notice: {
      message: notice.message,
      ...(notice.url === undefined ? {} : { url: notice.url }),
      ...(notice.code === undefined ? {} : { code: notice.code }),
    },
  }
}

/** Project a seam prompt, assigning the attempt-scoped identity answers name. */
function promptEvent(promptId: string, prompt: SeamPrompt): AuthEvent {
  const base = {
    promptId,
    kind: prompt.kind,
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
  }
  if (prompt.kind !== 'select') return { type: 'prompt', prompt: base }
  return {
    type: 'prompt',
    prompt: {
      ...base,
      options: (prompt.options ?? []).map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    },
  }
}

/** Host-side half of the hand-written Typert contribution. */
const HOST_CONTRIBUTION = {
  package: AUTH_PACKAGE,
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: AUTH_CONTRIBUTION.descriptors,
} as const

/** The Remote service the client namespace dispatches to. */
class AuthRemote {
  readonly typertRemote = {
    service: this,
    serviceKey: AUTH_NAMESPACE,
    namespace: AUTH_NAMESPACE,
  }

  private readonly attempts = new Map<string, Attempt>()
  private readonly active = new Map<string, Attempt>()

  constructor(
    private readonly ctx: Context,
    private readonly authorization: AuthorizationSeam,
  ) {}

  /** Every flow, with whether its credential is already stored. */
  async list(): Promise<AuthEntry[]> {
    const credentials = this.ctx.get('credentials') as CredentialsPort | undefined
    return Promise.all(
      this.authorization.list().map(async (flow) => {
        let provider = flow.key
        try {
          provider = credentialKeyId(flow.key as never)
        } catch {
          // A flow key outside the record grammar still renders; its card just
          // never matches a provider id.
        }
        return {
          key: flow.key,
          provider,
          label: flow.label,
          stored:
            credentials === undefined
              ? false
              : await credentials
                  .describeRecord(flow.key as never)
                  .then((record) => record.configured)
                  // A flow whose key the store cannot describe has no stored
                  // credential it could authenticate with.
                  .catch(() => false),
          inFlight: flow.inFlight,
        }
      }),
    )
  }

  /** Start one attempt; the flow runs in the background because it asks first. */
  async begin(key: string): Promise<AuthStart> {
    const flow = this.authorization.list().find((candidate) => candidate.key === key)
    if (flow === undefined) throw new Error(NO_FLOW)
    if (flow.inFlight || this.active.has(flow.key)) throw new Error(ALREADY_RUNNING)
    const attempt: Attempt = {
      id: randomUUID(),
      key: flow.key,
      controller: new AbortController(),
      events: [],
      prompts: new Map(),
      settled: false,
      nextPrompt: 1,
      timeout: undefined,
      retention: undefined,
    }
    this.attempts.set(attempt.id, attempt)
    this.active.set(attempt.key, attempt)
    this.prune()
    attempt.timeout = setTimeout(() => {
      attempt.controller.abort(new Error(TIMED_OUT))
    }, ATTEMPT_TIMEOUT_MS)
    attempt.timeout.unref()
    void this.run(attempt)
    return { attemptId: attempt.id }
  }

  /** Frames after the caller's cursor, plus whether this batch ended the attempt. */
  poll(attemptId: string, cursor: number): AuthPoll {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined) throw new Error(UNKNOWN_ATTEMPT)
    const start = Math.min(cursor, attempt.events.length)
    const events = attempt.events.slice(start)
    return {
      cursor: attempt.events.length,
      events,
      done: events.at(-1)?.type === 'settled',
    }
  }

  /** Deliver one answer to the flow; false means the question is already gone. */
  answer(attemptId: string, promptId: string, value: string): boolean {
    if (value.length > MAX_ANSWER) throw new Error(ANSWER_TOO_LONG)
    const attempt = this.attempts.get(attemptId)
    const pending = attempt?.prompts.get(promptId)
    if (attempt === undefined || pending === undefined) return false
    attempt.prompts.delete(promptId)
    pending.detach?.()
    pending.resolve(value)
    return true
  }

  /** Refuse one question as the human's decision, not as a broken surface. */
  decline(attemptId: string, promptId: string): boolean {
    const attempt = this.attempts.get(attemptId)
    const pending = attempt?.prompts.get(promptId)
    if (attempt === undefined || pending === undefined) return false
    attempt.prompts.delete(promptId)
    pending.detach?.()
    pending.reject(new Error(UNKNOWN_PROMPT))
    return true
  }

  /** Withdraw the attempt; the seam settles it cancelled even before the flow notices. */
  cancel(attemptId: string): void {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined || attempt.settled) return
    attempt.controller.abort(new Error(CANCELLED))
  }

  /** Run one flow and publish its settlement exactly once. */
  private async run(attempt: Attempt): Promise<void> {
    let status: 'authorized' | 'cancelled' | 'failed' = 'failed'
    let message: string | undefined
    try {
      const outcome = await this.authorization.begin({
        key: attempt.key,
        signal: attempt.controller.signal,
        interaction: {
          notify: (notice) => {
            this.push(attempt, noticeEvent(notice))
          },
          prompt: (prompt) => this.ask(attempt, prompt),
        },
      })
      status = outcome.status
    } catch (error) {
      if (attempt.controller.signal.aborted) status = 'cancelled'
      else {
        message = failureLine(error)
        this.ctx.logger.warn(`dsh-provider-extra: sign-in for "${attempt.key}" failed: ${message}`)
      }
    } finally {
      this.finish(attempt, status, message)
    }
  }

  /** Put one seam question to the poller and hold the flow until it is answered. */
  private ask(attempt: Attempt, prompt: SeamPrompt): Promise<string> {
    const promptId = `p${attempt.nextPrompt}`
    attempt.nextPrompt += 1
    return new Promise<string>((resolve, reject) => {
      const pending: Pending = { resolve, reject }
      const withdraw = (): void => {
        this.withdraw(attempt, promptId)
      }
      if (prompt.signal?.aborted === true) {
        reject(new Error(UNKNOWN_PROMPT))
        return
      }
      if (prompt.signal !== undefined) {
        prompt.signal.addEventListener('abort', withdraw, { once: true })
        pending.detach = () => {
          prompt.signal?.removeEventListener('abort', withdraw)
        }
      }
      attempt.prompts.set(promptId, pending)
      this.push(attempt, promptEvent(promptId, prompt))
    })
  }

  /** Retire a question the flow itself no longer needs answered. */
  private withdraw(attempt: Attempt, promptId: string): void {
    const pending = attempt.prompts.get(promptId)
    if (pending === undefined) return
    attempt.prompts.delete(promptId)
    pending.detach?.()
    this.push(attempt, { type: 'prompt-closed', promptId })
    pending.reject(new Error(UNKNOWN_PROMPT))
  }

  /** Release the key, close every question, and publish the terminal frame. */
  private finish(
    attempt: Attempt,
    status: 'authorized' | 'cancelled' | 'failed',
    message: string | undefined,
  ): void {
    if (attempt.settled) return
    attempt.settled = true
    if (attempt.timeout !== undefined) clearTimeout(attempt.timeout)
    attempt.timeout = undefined
    if (this.active.get(attempt.key) === attempt) this.active.delete(attempt.key)
    for (const promptId of [...attempt.prompts.keys()]) {
      const pending = attempt.prompts.get(promptId)
      attempt.prompts.delete(promptId)
      pending?.detach?.()
      this.push(attempt, { type: 'prompt-closed', promptId })
      pending?.reject(new Error(CANCELLED))
    }
    this.push(attempt, {
      type: 'settled',
      status,
      ...(message === undefined ? {} : { message }),
    })
    attempt.retention = setTimeout(() => {
      this.attempts.delete(attempt.id)
    }, SETTLED_RETENTION_MS)
    attempt.retention.unref()
  }

  /** Append one frame within the bound. */
  private push(attempt: Attempt, event: AuthEvent): void {
    if (attempt.events.length < MAX_EVENTS) attempt.events.push(event)
    else this.ctx.logger.warn('dsh-provider-extra: sign-in attempt exceeded its frame bound')
  }

  /** Keep retained attempts bounded, never evicting a live one. */
  private prune(): void {
    if (this.attempts.size <= MAX_ATTEMPTS) return
    for (const [id, attempt] of this.attempts) {
      if (this.attempts.size <= MAX_ATTEMPTS) return
      if (!attempt.settled) continue
      if (attempt.retention !== undefined) clearTimeout(attempt.retention)
      this.attempts.delete(id)
    }
  }
}

/** Mount the transport when the composition has both the seam and Typert. */
export function mountProviderAuth(ctx: Context): void {
  ctx.inject(['authorization', 'typert'], (owner) => {
    const authorization = owner.get('authorization') as unknown as AuthorizationSeam
    const service = new AuthRemote(owner, authorization)
    owner.provide(AUTH_NAMESPACE, service as never)
    owner.effect(() => {
      try {
        return (owner.get('typert') as unknown as TypertPort).register(HOST_CONTRIBUTION)
      } catch (error) {
        owner.logger.error('dsh-provider-extra: sign-in transport registration failed')
        owner.logger.error(error)
        throw error
      }
    })
  })
}
