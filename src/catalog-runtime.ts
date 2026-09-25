/** Managed composition uses one immutable adapter snapshot and no settings overlay. */
import type { Context } from '@deepseek-ai/cordis'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { LlmError, assertUsableApiKey, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { codexAuth } from './codex.ts'
import type { CodexCredentialService } from './codex.ts'
import type { CatalogSnapshot } from './catalog.ts'
import { catalogDefault } from './catalog-default.ts'

const PLUGIN_NAME = 'dsh-provider-extra'
const OWNER_COLLISION = 'CATALOG_OWNER_COLLISION'

interface Credentials extends CodexCredentialService {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** Preflight prevents even an unrelated competing row from expanding managed membership. */
function assertCatalogOwnership(ctx: Context, ownedRoutes: readonly string[] = [], defaultOwner?: unknown): void {
  const currentDefault = ctx.get('agentDefaultModel') as unknown
  if ((currentDefault !== undefined && currentDefault !== defaultOwner)
    || ctx.llm.listProviders().some(provider => !ownedRoutes.includes(provider.id))
    || ctx.llm.listConfigurableProviders().length > 0) {
    throw new LlmError(
      'dsh-provider-extra: ' + OWNER_COLLISION + ': disable competing provider and agent-default-model rows in this opted-in profile before mounting catalog',
      OWNER_COLLISION,
    )
  }
}

/** Immutable closures also keep prepared and in-flight calls on their original revision. */
export function mountCatalog(ctx: Context, snapshot: CatalogSnapshot): void {
  assertCatalogOwnership(ctx)
  let ownershipError: unknown
  const requireOwnership = (): void => {
    if (ownershipError !== undefined) throw ownershipError
  }
  const auth = codexAuth(() => ctx.get('credentials') as Credentials | undefined)
  const credentialId = (route: string): string => {
    const configured = snapshot.providers.get(route)?.auth
    return configured !== undefined && 'credentialProvider' in configured ? configured.credentialProvider : route
  }
  const adapter = new PiAiAdapter({
    profiles: () => { requireOwnership(); return snapshot.profiles },
    auth: {
      ...auth,
      // Route aliases must share the source provider's existing OAuth grant.
      credentials: {
        read: async route => {
          requireOwnership()
          try {
            return await auth.credentials.read(credentialId(route))
          } finally {
            requireOwnership()
          }
        },
        modify: async (route, change) => {
          requireOwnership()
          try {
            return await auth.credentials.modify(credentialId(route), current => {
              // A rotated token must persist; the outer guard still blocks model dispatch.
              requireOwnership()
              return change(current)
            })
          } finally {
            requireOwnership()
          }
        },
        delete: route => auth.credentials.delete(credentialId(route)),
        list: async () => {
          const stored = await auth.credentials.list()
          return [...snapshot.providers.values()].flatMap(provider => {
            if (!('credentialProvider' in provider.auth)) return []
            const record = stored.find(item => item.providerId === credentialId(provider.id))
            return record === undefined ? [] : [{ ...record, providerId: provider.id }]
          })
        },
      },
    },
    resolveApiKey: async (route) => {
      // Prepared calls retain their snapshot and bypass profiles(); this gate
      // stops a newly conflicting composition before credential-backed dispatch.
      requireOwnership()
      const configured = snapshot.providers.get(route)
      if (configured === undefined) throw new LlmError('dsh-provider-extra: unknown catalog route "' + route + '"', 'UNKNOWN_PROVIDER')
      if (!('apiKeyRef' in configured.auth)) return undefined
      const ref = configured.auth.apiKeyRef
      const credentials = ctx.get('credentials') as Credentials | undefined
      const key = credentials === undefined ? process.env[ref] : (await credentials.resolve(ref))?.value
      requireOwnership()
      if (key !== undefined && key.length > 0) return assertUsableApiKey(key, PLUGIN_NAME, ref)
      throw new LlmError('dsh-provider-extra: no credential for route "' + route + '"; its Config references ' + ref, 'MISSING_CREDENTIAL')
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn('dsh-provider-extra: unusable replay state for "' + provider + '/' + model + '" (' + reason + ')')
    },
  })
  const routes = [...snapshot.profiles.keys()]
  // The runtime rejects an empty registration; an explicitly empty catalog
  // instead owns only the default contract, which reports NO_DEFAULT_MODEL.
  if (routes.length > 0) ctx.llm.registerAdapter(routes, adapter)
  const defaults = catalogDefault(ctx, snapshot, requireOwnership)
  ctx.provide('agentDefaultModel', defaults)
  // Notifications follow registry commit: diagnose, never veto or mutate the
  // other owner. Disposing this listener leaves retained valid calls intact.
  const refreshOwnership = (): void => {
    try {
      assertCatalogOwnership(ctx, routes, defaults)
      ownershipError = undefined
    } catch (error) {
      const previous = ownershipError
      ownershipError = error
      if (previous === undefined) ctx.logger.error(error)
    }
  }
  ctx.on('llm/adapters-updated', refreshOwnership)
  refreshOwnership()
  // A public update veto runs before disposal, so a competing late-mounted
  // adapter cannot turn a refused reload into loss of the last valid catalog.
  ctx.on('internal/update', (next, _noSave, proceed) => {
    if (next.catalog !== undefined) assertCatalogOwnership(ctx, routes, defaults)
    return proceed()
  })
  ctx.inject(['settings'], (child) => {
    const settings = child.get('settings') as { configure?: (options: { auto: boolean }, fiber: typeof ctx.fiber) => () => void }
    if (typeof settings.configure === 'function') child.effect(() => settings.configure!({ auto: false }, ctx.fiber))
  })
}
