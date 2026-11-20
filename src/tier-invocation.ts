/** Process-local request scope keeps paid headless policy out of durable session state. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as llm from '@deepseek-ai/dsh-llm'
import type { TierSelection } from './service-tiers.ts'

const SERVICE_NAME = 'providerTierInvocation'
const SINGLE_ROOT = 1
const AMBIGUOUS_ROOT = 'headless service tier override cannot identify a unique invoking root'
const UNSUPPORTED_RUNTIME =
  'headless service tiers require the npm DSH loop marker and an agents registry that lists live agents'
const scope = new AsyncLocalStorage<string | null | undefined>()

/**
 * The public registry determines runtime ownership, not user-supplied request metadata.
 * Releases before 0.2.2-rc.5 expose `roots()`; later ones keep only `list()`.
 */
export interface TierInvocationAgents {
  roots?(): readonly { readonly id: string }[]
  list?(): readonly { readonly id: string }[]
}

/**
 * Live agents the binding chooses from. `list()` also returns owned children, but a
 * child normally appears only after the root's first loop request has bound it, and
 * a bound root still matches only its own session id. A child that appears earlier
 * leaves more than one candidate, so the override fails closed instead of binding it.
 */
function liveRoots(agents: TierInvocationAgents): readonly { readonly id: string }[] {
  if (typeof agents.roots === 'function') return agents.roots()
  if (typeof agents.list === 'function') return agents.list()
  throw new Error(UNSUPPORTED_RUNTIME)
}

/** Only the headless startup opts in; ordinary provider mounting never waits for headless services. */
export interface TierInvocationController {
  /** Startup owns the returned lease; stale cleanup cannot revoke a newer activation. */
  activate(
    override: string | undefined,
    sessionId: string | undefined,
    agents: TierInvocationAgents,
  ): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    providerTierInvocation: TierInvocationController
  }
}

/** Null suppresses saved policy; undefined leaves normal configured/shared defaults intact. */
export function currentInvocationTier(): string | null | undefined {
  return scope.getStore()
}

/** Mount once beside the tier owner; startup injects this service and supplies the public agents registry. */
export function mountTierInvocation(ctx: Context, tiers: TierSelection): void {
  let active:
    | {
        override: string
        sessionId: string | undefined
        agents: TierInvocationAgents
        previousRoots: ReadonlySet<object>
        root?: { readonly id: string }
      }
    | undefined
  ctx.provide(SERVICE_NAME, {
    activate(override, sessionId, agents) {
      if (
        override !== undefined &&
        (typeof llm.isAgentLoopRequest !== 'function' ||
          (typeof agents.roots !== 'function' && typeof agents.list !== 'function'))
      ) {
        throw new Error(UNSUPPORTED_RUNTIME)
      }
      active =
        override === undefined
          ? undefined
          : {
              override,
              sessionId,
              agents,
              previousRoots: new Set(liveRoots(agents)),
            }
      const activation = active
      return () => {
        if (active === activation) active = undefined
      }
    },
  } satisfies TierInvocationController)
  ctx.effect(() => () => {
    active = undefined
  })
  ctx.on('llm/stream', (request, next) => {
    const tier = resolve(request)
    // Even excluded nested calls need an explicit empty scope rather than inheriting their caller's tier.
    return {
      [Symbol.asyncIterator]() {
        const iterator = scope.run(tier, () => next()[Symbol.asyncIterator]())
        return {
          next: (...args: [] | [undefined]) => scope.run(tier, () => iterator.next(...args)),
          return: (value?: unknown) =>
            scope.run(tier, () =>
              iterator.return
                ? iterator.return(value)
                : Promise.resolve({ done: true as const, value }),
            ),
          throw: (error?: unknown) =>
            scope.run(tier, () => (iterator.throw ? iterator.throw(error) : Promise.reject(error))),
        } satisfies AsyncIterator<StreamChunk>
      },
    }
  })

  /** Bind one newly registered root, or the exact resumed root, before accepting request metadata. */
  function resolve(request: GenerateOptions): string | null | undefined {
    // A local copy keeps the narrowing inside the filter below; nothing here awaits.
    const current = active
    if (
      !current ||
      !llm.isAgentLoopRequest(request) ||
      !request.sessionId ||
      request.purpose !== undefined
    )
      return undefined
    const roots = liveRoots(current.agents)
    if (!current.root) {
      const candidates = roots.filter(
        (root) =>
          !current.previousRoots.has(root) &&
          (current.sessionId === undefined || root.id === current.sessionId),
      )
      if (candidates.length !== SINGLE_ROOT) {
        // Falling back here could restore saved paid processing against an explicit provider-default request.
        if (candidates.some((root) => root.id === request.sessionId))
          throw new Error(AMBIGUOUS_ROOT)
        return undefined
      }
      current.root = candidates[0]
    }
    const { root } = current
    if (!root || !roots.includes(root) || root.id !== request.sessionId) return undefined
    return tiers.resolve(request.provider, request.model, current.override)
  }
}
