/** Process-local request scope keeps paid headless policy out of durable session state. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import * as llm from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { TierSelection } from './service-tiers.ts'

const SERVICE_NAME = 'providerTierInvocation'
const SINGLE_ROOT = 1
const AMBIGUOUS_ROOT = 'headless service tier override cannot identify a unique invoking root'
const UNSUPPORTED_RUNTIME = 'headless service tiers require the npm DSH 0.2.0-rc.2 loop marker and agents root registry'
const scope = new AsyncLocalStorage<string | null | undefined>()

/** The public registry determines runtime ownership, not user-supplied request metadata. */
export interface TierInvocationAgents {
  roots(): readonly { readonly id: string }[]
}

/** Only the headless startup opts in; ordinary provider mounting never waits for headless services. */
export interface TierInvocationController {
  /** Startup owns the returned lease; stale cleanup cannot revoke a newer activation. */
  activate(override: string | undefined, sessionId: string | undefined, agents: TierInvocationAgents): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context { providerTierInvocation: TierInvocationController }
}

/** Null suppresses saved policy; undefined leaves normal configured/shared defaults intact. */
export function currentInvocationTier(): string | null | undefined {
  return scope.getStore()
}

/** Mount once beside the tier owner; startup injects this service and supplies the public agents registry. */
export function mountTierInvocation(ctx: Context, tiers: TierSelection): void {
  let active: {
    override: string
    sessionId: string | undefined
    agents: TierInvocationAgents
    previousRoots: ReadonlySet<object>
    root?: { readonly id: string }
  } | undefined
  ctx.provide(SERVICE_NAME, {
    activate(override, sessionId, agents) {
      if (override !== undefined && (typeof llm.isAgentLoopRequest !== 'function' || typeof agents.roots !== 'function')) {
        throw new Error(UNSUPPORTED_RUNTIME)
      }
      active = override === undefined ? undefined : {
        override, sessionId, agents, previousRoots: new Set(agents.roots()),
      }
      const activation = active
      return () => { if (active === activation) active = undefined }
    },
  } satisfies TierInvocationController)
  ctx.effect(() => () => { active = undefined })
  ctx.on('llm/stream', (request, next) => {
    const tier = resolve(request)
    // Even excluded nested calls need an explicit empty scope rather than inheriting their caller's tier.
    return {
      [Symbol.asyncIterator]() {
        const iterator = scope.run(tier, () => next()[Symbol.asyncIterator]())
        return {
          next: (...args: [] | [undefined]) => scope.run(tier, () => iterator.next(...args)),
          return: (value?: unknown) => scope.run(tier, () => iterator.return
            ? iterator.return(value) : Promise.resolve({ done: true as const, value })),
          throw: (error?: unknown) => scope.run(tier, () => iterator.throw
            ? iterator.throw(error) : Promise.reject(error)),
        } satisfies AsyncIterator<StreamChunk>
      },
    }
  })

  /** Bind one newly registered root, or the exact resumed root, before accepting request metadata. */
  function resolve(request: GenerateOptions): string | null | undefined {
    if (!active || !llm.isAgentLoopRequest(request) || !request.sessionId || request.purpose !== undefined) return undefined
    const roots = active.agents.roots()
    if (!active.root) {
      const candidates = roots.filter(root => !active!.previousRoots.has(root)
        && (active!.sessionId === undefined || root.id === active!.sessionId))
      if (candidates.length !== SINGLE_ROOT) {
        // Falling back here could restore saved paid processing against an explicit provider-default request.
        if (candidates.some(root => root.id === request.sessionId)) throw new Error(AMBIGUOUS_ROOT)
        return undefined
      }
      active.root = candidates[0]
    }
    if (!roots.includes(active.root!) || active.root!.id !== request.sessionId) return undefined
    return tiers.resolve(request.provider, request.model, active.override)
  }
}
