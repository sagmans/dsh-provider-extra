/**
 * dsh-provider-extra: extra LLM provider routes for DeepSeek Harness.
 *
 * Without a catalog, mounts two additive routes. An opted-in catalog owns
 * the profile's complete model selection and default instead.
 * OpenCode Go stamps the x-opencode-session header
 * from the live dsh session id, which the gateway requires for routing and
 * prompt-cache affinity and which the shipped adapters do not send. OpenAI
 * Codex serves a ChatGPT subscription through pi-ai's OAuth: the grant lives
 * in the harness credential store (see src/codex-login.ts for the sign-in),
 * because no shipped surface consumes DSH core's own Codex authorization flow.
 *
 * Registration is the profile's job: `dsh plugin add` installs the package and
 * its bundle patch mounts this module, so no path is ever written down.
 *
 *     dsh plugin --profile web add @sagmans/dsh-provider-extra
 *
 * An ID-targeted override changes the config after that:
 *
 *     - id: dsh-provider-extra
 *       config:
 *         apiKeyEnv: OPENCODE_API_KEY
 *         # routeId: opencode-go        # default; keep it out of llm-pi-ai providers
 *         # baseURL: https://opencode.ai/zen/go/v1
 *         # fallbackSessionId: dsh-provider-extra
 *         # codexEnabled: true          # sign in with: /dsh-provider-extra-login
 *         # codexRouteId: openai-codex  # default; keep it out of llm-pi-ai providers
 *
 * @module dsh-provider-extra
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { LlmError, assertUsableApiKey, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { Transport } from '@earendil-works/pi-ai'
import {
  DEFAULT_EXTRA_MODEL_TEMPLATE,
  DEFAULT_OPENCODE_API_KEY_ENV,
  OPENCODE_GO_PROVIDER_ID,
  buildOpenCodeGoProfile,
} from './opencode-go.ts'
import type { OpenCodeGoRouteConfig } from './opencode-go.ts'
import type { ExtraModelSpec } from './extra-models.ts'
import {
  DEFAULT_CODEX_DISPLAY_NAME,
  DEFAULT_CODEX_ROUTE_ID,
  buildCodexProfile,
  codexApiKey,
  codexAuth,
} from './codex.ts'
import { CODEX_TRANSPORTS } from './codex.ts'
import type { CodexCredentialService, CodexRouteConfig } from './codex.ts'
import { DEFAULT_LOGIN_COMMAND_NAME } from './login-command.ts'
import { mountLoginCommand } from './login-host.ts'
import { compileCatalog } from './catalog.ts'
import type { CatalogConfig } from './catalog.ts'
import { mountCatalog } from './catalog-runtime.ts'

export { compileCatalog } from './catalog.ts'
export type { CatalogConfig, CatalogProvider, CatalogModel, CatalogSelection, CatalogSnapshot } from './catalog.ts'
export { buildCatalogProfile } from './catalog-routes.ts'

/** Settings namespace configuration surfaces address this plugin's section by. */
const SETTINGS_NS = 'dsh-provider-extra'

// Declared extra models: the composition entry and the settings section share
// these two shapes, so one document's declaration is valid in the other.
const goExtraModelSchema: Schema<ExtraModelSpec> = Schema.object({
  id: Schema.string().required(),
  name: Schema.string(),
  template: Schema.string().default(DEFAULT_EXTRA_MODEL_TEMPLATE),
})

// The Codex route ships no default template: a declaration must name the
// sibling it clones, because a clone from another vendor's catalog would be
// dispatched as if the subscription served it.
const codexExtraModelSchema: Schema<ExtraModelSpec> = Schema.object({
  id: Schema.string().required(),
  name: Schema.string(),
  template: Schema.string(),
})

export interface Config {
  /** Presence opts this profile into exclusive, validated catalog ownership. */
  catalog?: CatalogConfig
  apiKeyEnv: string
  routeId: string
  displayName: string
  baseURL?: string
  fallbackSessionId?: string
  headers?: Record<string, string>
  /**
   * Extra models for the OpenCode Go route. It lives in the composition entry
   * rather than only in the settings section because a harness without a
   * settings document can only deliver a profile's declared extras through
   * its own config; a settings section still overrides this whole array.
   */
  extraModels?: readonly ExtraModelSpec[]
  /** Exact model ids the OpenCode Go route serves, in this order. */
  models?: readonly string[]
  codexEnabled: boolean
  codexRouteId: string
  codexDisplayName: string
  /** Extra models for the Codex route, under the same precedence as {@link extraModels}. */
  codexExtraModels?: readonly ExtraModelSpec[]
  /** Exact model ids the Codex route serves, in this order. */
  codexModels?: readonly string[]
  /**
   * Transport to pin on every Codex request. Unset keeps pi-ai's own choice,
   * whose websocket path needs a connection that outlives the response; a
   * deployment where that connection never settles pins sse instead.
   */
  codexTransport?: Transport
  loginCommandEnabled: boolean
  loginCommandName: string
}

// The assertion carries the one thing schemastery cannot state: every array in
// this entry is read-only to the plugin, which only ever copies it, while an
// array member schema is typed as the mutable array it validates.
export const Config: Schema<Config> = Schema.transform(Schema.object({
  // Keep raw catalog presence: schemastery otherwise materializes absent arrays.
  catalog: Schema.any(),
  apiKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_OPENCODE_API_KEY_ENV),
  routeId: Schema.string().default(OPENCODE_GO_PROVIDER_ID),
  displayName: Schema.string().default('OpenCode Go'),
  baseURL: Schema.string(),
  fallbackSessionId: Schema.string(),
  headers: Schema.dict(Schema.string()),
  extraModels: Schema.array(goExtraModelSchema),
  models: Schema.array(Schema.string()),
  codexEnabled: Schema.boolean().default(true),
  codexRouteId: Schema.string().default(DEFAULT_CODEX_ROUTE_ID),
  codexDisplayName: Schema.string().default(DEFAULT_CODEX_DISPLAY_NAME),
  codexExtraModels: Schema.array(codexExtraModelSchema),
  codexModels: Schema.array(Schema.string()),
  codexTransport: Schema.union(CODEX_TRANSPORTS),
  loginCommandEnabled: Schema.boolean().default(true),
  loginCommandName: Schema.string().default(DEFAULT_LOGIN_COMMAND_NAME),
}), (value) => {
  // Object-level validation also sees explicit null, which field transforms skip.
  // Loader validates before disposal, retaining the previous snapshot on failure.
  compileCatalog(value.catalog)
  return value
}, true) as Schema<Config>

/**
 * One configured model selection, or nothing when the entry declared none.
 * schemastery materializes an undeclared array member as an empty array, so an
 * empty declaration is the absence of a selection: the route serves everything
 * its catalog and extras resolved, exactly as a profile that never named the
 * field does.
 */
function selection(declared: readonly string[] | undefined): readonly string[] | undefined {
  return declared === undefined || declared.length === 0 ? undefined : declared
}

export const name = 'dsh-provider-extra'
export const inject = ['llm']

/**
 * Restart-free model additions, read from the settings section per request.
 * The section layer sits over the composition entry, so a harness with a
 * settings document reshapes these two arrays and one without keeps the
 * entry's own values (see {@link Config.extraModels}).
 */
export interface ProviderExtraSection {
  /** Extra models served beside the installed catalog; later entries win by id. */
  extraModels: ExtraModelSpec[]
  /** Extra models the Codex route serves; each names the catalog sibling it clones. */
  codexExtraModels: ExtraModelSpec[]
}

const SectionSchema: Schema<ProviderExtraSection> = Schema.object({
  extraModels: Schema.array(goExtraModelSchema).default([]),
  codexExtraModels: Schema.array(codexExtraModelSchema).default([]),
})

/**
 * The credential seam when present; resolved per request, never at mount.
 * Records and references are the two halves of the same service: a route
 * authenticates from one or the other, never both at once.
 */
interface CredentialService extends CodexCredentialService {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

export function apply(ctx: Context, config: Config): void {
  const snapshot = compileCatalog(config.catalog)
  if (snapshot !== undefined) {
    mountCatalog(ctx, snapshot, config)
    return
  }
  const models = selection(config.models)
  const codexModels = selection(config.codexModels)
  const route: OpenCodeGoRouteConfig = {
    provider: config.routeId,
    displayName: config.displayName,
    apiKeyEnv: config.apiKeyEnv,
    ...config.baseURL === undefined ? {} : { baseURL: config.baseURL },
    ...config.fallbackSessionId === undefined ? {} : { fallbackSessionId: config.fallbackSessionId },
    ...config.headers === undefined ? {} : { headers: { ...config.headers } },
    ...models === undefined ? {} : { models },
  }

  const codex: CodexRouteConfig = {
    provider: config.codexRouteId,
    displayName: config.codexDisplayName,
    ...codexModels === undefined ? {} : { models: codexModels },
    ...config.codexTransport === undefined ? {} : { transport: config.codexTransport },
  }

  // The entry's own declarations are the base layer the settings section sits
  // over, and the value the routes serve on a harness with no settings document
  // at all — which is why they seed the thunk below instead of only the base.
  const entry: ProviderExtraSection = {
    extraModels: [...config.extraModels ?? []],
    codexExtraModels: [...config.codexExtraModels ?? []],
  }

  // A declared selection is configuration, not a request fact, so it is proven
  // once here. Registration resolves a profile for its route metadata and
  // reports a failure as a refused route, which would bury the one message that
  // names the misconfigured id; resolving per request would bury it the same
  // way. The extras a selection resolves against at this point are the entry's
  // own, because a settings document may not have arrived yet.
  if (models !== undefined) buildOpenCodeGoProfile({ ...route, extraModels: entry.extraModels })
  if (codexModels !== undefined) buildCodexProfile({ ...codex, extraModels: entry.codexExtraModels })

  // The catalog check stays boot-time even though settings can now extend the
  // profile per request: a catalog drift (pi-ai no longer shipping Codex) must
  // stand this route down once, loudly, here, instead of failing every request
  // on both routes.
  let codexServable = false
  if (config.codexEnabled) {
    try {
      // Catalog drift alone: the selection was already proven above, so it
      // cannot be what this check reports.
      buildCodexProfile({ provider: codex.provider, displayName: codex.displayName })
      codexServable = true
    } catch (error) {
      ctx.logger.error('dsh-provider-extra: codex route "' + codex.provider + '" disabled; the installed pi-ai catalog cannot serve it')
      ctx.logger.error(error)
    }
  }

  // Route wiring is boot-time, but the model list is per-request: the section
  // thunk below tracks the settings overlay, so a committed extras change
  // reaches the next operation with no rebuild and no restart.
  let currentSection: () => ProviderExtraSection = () => entry
  const profiles = (): Map<string, ResolvedPiAiProviderProfile> => {
    const section = currentSection()
    // Selections stay bound to the entry extras that passed mount-time validation.
    const entries: [string, ResolvedPiAiProviderProfile][] = [
      [route.provider, buildOpenCodeGoProfile({
        ...route, extraModels: models !== undefined ? entry.extraModels : section.extraModels,
      })],
    ]
    if (codexServable) {
      entries.push([codex.provider, buildCodexProfile({
        ...codex, extraModels: codexModels !== undefined ? entry.codexExtraModels : section.codexExtraModels,
      })])
    }
    return new Map(entries)
  }
  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey: async (provider) => {
      // The Codex route authenticates from the stored OAuth grant, never
      // from a key: absent here is what lets the collection store serve it.
      if (provider === codex.provider) return codexApiKey()
      const credentials = ctx.get('credentials') as CredentialService | undefined
      const hit = credentials !== undefined
        ? (await credentials.resolve(route.apiKeyEnv))?.value
        : process.env[route.apiKeyEnv]
      if (hit !== undefined && hit.length > 0) {
        return assertUsableApiKey(hit, name, route.apiKeyEnv)
      }
      throw new LlmError(
        'dsh-provider-extra: no credential for route "' + route.provider + '"; its profile resolves ' + route.apiKeyEnv
        + ', which is not set — store it through the credentials service or export it',
        'MISSING_CREDENTIAL',
      )
    },
    // One shared injection for both routes: the OpenCode Go key arrives as
    // the request-level override (preferred over every store read), so the
    // harness-backed grant store serves Codex while changing nothing for it.
    auth: codexAuth(() => ctx.get('credentials') as CodexCredentialService | undefined),
    // Both routes carry images: history with a read_image result reaches this
    // adapter as durable references, and pi-ai refuses the whole turn unless
    // the composition's attachment store resolves their bytes here. The
    // execution-world mapping is separately optional — a composition without
    // the filesystem service still sends the image, only without the
    // model-facing normalized-copy path.
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    // A stored replay state the installed pi-ai cannot reconstruct already
    // degrades to provider-neutral content; naming it keeps that downgrade
    // diagnosable instead of silent.
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn('dsh-provider-extra: unusable replay state on assistant history for route "'
        + provider + '/' + model + '"; sending that message as provider-neutral content (' + reason + ')')
    },
  })

  // A route another adapter already owns (opencode-go configured under
  // llm-pi-ai) must not brick the whole composition: the refusal names the
  // remediation and every other plugin keeps working.
  try {
    ctx.llm.registerAdapter([route.provider], adapter)
  } catch (error) {
    ctx.logger.error('dsh-provider-extra: route "' + route.provider + '" was refused;'
      + " remove it from llm-pi-ai's providers section to serve it here")
    ctx.logger.error(error)
    return
  }
  // Separately from the OpenCode Go route, because registration is
  // all-or-nothing: one call for both would drop a working route when the
  // other collides. llm-pi-ai's directory already lists the catalog id, so
  // no directory entry is registered here — core's serves the Models page.
  if (codexServable) {
    try {
      ctx.llm.registerAdapter([codex.provider], adapter)
    } catch (error) {
      ctx.logger.warn('dsh-provider-extra: codex route "' + codex.provider + '" stays with its existing owner;'
        + " remove it from llm-pi-ai's providers section to serve it here")
      ctx.logger.warn(error)
    }
  }
  try {
    ctx.llm.registerConfigurableProviders([{
      provider: route.provider,
      displayName: route.displayName,
      settingsNs: SETTINGS_NS,
      settingsPath: [route.provider],
    }])
  } catch (error) {
    // llm-pi-ai already lists every catalog id in the directory, including
    // opencode-go; its entry keeps serving the Models page here.
    ctx.logger.warn('dsh-provider-extra: directory entry for "' + route.provider + '" stays with its existing owner')
    ctx.logger.warn(error)
  }
  ctx.inject(['settings'], (settingsCtx) => {
    // The section overrides the entry where a settings document exists and
    // stands in for it where none does; the settings service falls back to this
    // same value when it detaches.
    settingsCtx.settings.installSection(ctx, SETTINGS_NS, SectionSchema, entry, {
      setSource: (source) => { currentSection = source },
      // No registration facts derive from the section: the route set is fixed
      // at composition and the adapter rebuilds its snapshot on every
      // operation, so a committed extras change applies alone.
      onChange: () => { /* per-operation snapshot; no swap needed */ },
    })
  })
  mountLoginCommand(ctx, config, { profiles })
}
