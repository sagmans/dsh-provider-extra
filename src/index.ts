/**
 * dsh-provider-extra: extra LLM provider routes for DeepSeek Harness.
 *
 * Mounts two routes today. OpenCode Go stamps the x-opencode-session header
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
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials'
import { LlmError, assertUsableApiKey, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import { createModels } from '@earendil-works/pi-ai'
import type { Provider } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import {
  DEFAULT_EXTRA_MODEL_TEMPLATE,
  DEFAULT_OPENCODE_API_KEY_ENV,
  OPENCODE_GO_PROVIDER_ID,
  buildOpenCodeGoProfile,
} from './opencode-go.ts'
import type { ExtraModelSpec, OpenCodeGoRouteConfig } from './opencode-go.ts'
import {
  DEFAULT_CODEX_DISPLAY_NAME,
  DEFAULT_CODEX_ROUTE_ID,
  buildCodexProfile,
  codexApiKey,
  codexAuth,
  recordKeyFor,
} from './codex.ts'
import type { CodexCredentialService, CodexRouteConfig } from './codex.ts'
import { DEFAULT_LOGIN_COMMAND_NAME, createLoginCommand } from './login-command.ts'
import type { LoginChoice, LoginCommandHost } from './login-contract.ts'
import { declareProviderRoute, declaredCredentialRef } from './login-route.ts'
import { PendingCredentialStore, proveApiKey } from './login-verify.ts'

/** Settings namespace configuration surfaces address this plugin's section by. */
const SETTINGS_NS = 'dsh-provider-extra'

export interface Config {
  apiKeyEnv: string
  routeId: string
  displayName: string
  baseURL?: string
  fallbackSessionId?: string
  headers?: Record<string, string>
  codexEnabled: boolean
  codexRouteId: string
  codexDisplayName: string
  loginCommandEnabled: boolean
  loginCommandName: string
}

export const Config: Schema<Config> = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_OPENCODE_API_KEY_ENV),
  routeId: Schema.string().default(OPENCODE_GO_PROVIDER_ID),
  displayName: Schema.string().default('OpenCode Go'),
  baseURL: Schema.string(),
  fallbackSessionId: Schema.string(),
  headers: Schema.dict(Schema.string()),
  codexEnabled: Schema.boolean().default(true),
  codexRouteId: Schema.string().default(DEFAULT_CODEX_ROUTE_ID),
  codexDisplayName: Schema.string().default(DEFAULT_CODEX_DISPLAY_NAME),
  loginCommandEnabled: Schema.boolean().default(true),
  loginCommandName: Schema.string().default(DEFAULT_LOGIN_COMMAND_NAME),
})

export const name = 'dsh-provider-extra'
export const inject = ['llm']

/** Restart-free model additions for the route, read from the settings section per request. */
export interface ProviderExtraSection {
  /** Extra models served beside the installed catalog; later entries win by id. */
  extraModels: ExtraModelSpec[]
}

const extraModelSchema: Schema<ExtraModelSpec> = Schema.object({
  id: Schema.string().required(),
  name: Schema.string(),
  template: Schema.string().default(DEFAULT_EXTRA_MODEL_TEMPLATE),
})

const SectionSchema: Schema<ProviderExtraSection> = Schema.object({
  extraModels: Schema.array(extraModelSchema).default([]),
})

/**
 * The credential seam when present; resolved per request, never at mount.
 * Records and references are the two halves of the same service: a route
 * authenticates from one or the other, never both at once.
 */
interface CredentialService extends CodexCredentialService {
  resolve(ref: string): Promise<{ value: string } | undefined>
  describe(ref: string): Promise<CredentialInfo>
}

/**
 * Every catalog provider that ships an interactive login, in catalog order.
 * The catalog is the authority on how a provider signs in — which methods it
 * offers, and what each is called — so the picker never re-decides that here.
 */
function loginChoices(): readonly LoginChoice[] {
  const choices: LoginChoice[] = []
  for (const provider of builtinProviders()) {
    const oauth = provider.auth?.oauth
    if (oauth?.login !== undefined) {
      choices.push({
        providerId: provider.id,
        providerName: provider.name,
        authType: 'oauth',
        methodLabel: oauth.loginLabel ?? oauth.name,
      })
    }
    const apiKey = provider.auth?.apiKey
    if (apiKey?.login !== undefined) {
      choices.push({
        providerId: provider.id,
        providerName: provider.name,
        authType: 'api_key',
        methodLabel: apiKey.name,
      })
    }
  }
  return choices
}

/** The catalog provider behind one sign-in choice. */
function catalogLoginProvider(providerId: string): Provider {
  const found = builtinProviders().find(provider => provider.id === providerId)
  if (found === undefined) {
    throw new Error('dsh-provider-extra: the installed pi-ai catalog no longer ships provider "' + providerId + '"')
  }
  return found
}

export function apply(ctx: Context, config: Config): void {
  const route: OpenCodeGoRouteConfig = {
    provider: config.routeId,
    displayName: config.displayName,
    apiKeyEnv: config.apiKeyEnv,
    ...config.baseURL === undefined ? {} : { baseURL: config.baseURL },
    ...config.fallbackSessionId === undefined ? {} : { fallbackSessionId: config.fallbackSessionId },
    ...config.headers === undefined ? {} : { headers: { ...config.headers } },
  }

  const codex: CodexRouteConfig = {
    provider: config.codexRouteId,
    displayName: config.codexDisplayName,
  }

  // The Codex profile is boot-time, not per-request: it takes no settings
  // inputs, and building it per operation would let a catalog drift (pi-ai no
  // longer shipping Codex) fail every request on both routes instead of just
  // standing this route down once, loudly, here.
  let codexProfile: ResolvedPiAiProviderProfile | undefined
  if (config.codexEnabled) {
    try {
      codexProfile = buildCodexProfile(codex)
    } catch (error) {
      ctx.logger.error('dsh-provider-extra: codex route "' + codex.provider + '" disabled; the installed pi-ai catalog cannot serve it')
      ctx.logger.error(error)
    }
  }

  // Route wiring is boot-time, but the model list is per-request: the section
  // thunk below tracks the settings overlay, so a committed extras change
  // reaches the next operation with no rebuild and no restart.
  let currentSection: () => ProviderExtraSection = () => ({ extraModels: [] })
  const profiles = (): Map<string, ResolvedPiAiProviderProfile> => {
    const entries: [string, ResolvedPiAiProviderProfile][] = [
      [route.provider, buildOpenCodeGoProfile({ ...route, extraModels: currentSection().extraModels })],
    ]
    if (codexProfile !== undefined) entries.push([codex.provider, codexProfile])
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
  if (codexProfile !== undefined) {
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
    settingsCtx.settings.installSection(ctx, SETTINGS_NS, SectionSchema, { extraModels: [] }, {
      setSource: (source) => { currentSection = source },
      // No registration facts derive from the section: the route set is fixed
      // at composition and the adapter rebuilds its snapshot on every
      // operation, so a committed extras change applies alone.
      onChange: () => { /* per-operation snapshot; no swap needed */ },
    })
  })
  // The command is the registry-install-friendly half of the attended sign-in:
  // it runs in this process, so the credential lands in the store the routes
  // already read and no bin path or peer tree is involved. It signs into any
  // provider the installed catalog ships a login for, not only the two routes
  // this plugin mounts, because a human asking to sign in means the provider
  // they name and nothing narrower. Profiles without a command registry
  // (headless compositions) keep the package bin.
  if (config.loginCommandEnabled) {
    ctx.inject(['commands'], (commandCtx) => {
      const host: LoginCommandHost = {
        choices: loginChoices,
        login: async (choice, interaction) => {
          const credentials = () => ctx.get('credentials') as CodexCredentialService | undefined
          const auth = codexAuth(credentials)
          const models = createModels(auth)
          // pi-ai's collection starts empty: the catalog provider carrying the
          // login implementation has to be handed to it before the flow runs.
          models.setProvider(catalogLoginProvider(choice.providerId))
          if (choice.authType !== 'api_key') {
            await models.login(choice.providerId, choice.authType, interaction)
            return await declareProviderRoute(ctx.get('settings'), choice.providerId)
          }
          // A grant the provider minted proves itself, but a key proves nothing
          // until a request carries it, so the key is spent from a store that
          // forgets and the profile hears of it only once it has been accepted.
          const pending = createModels({ credentials: new PendingCredentialStore(), authContext: auth.authContext })
          pending.setProvider(catalogLoginProvider(choice.providerId))
          const credential = await pending.login(choice.providerId, choice.authType, interaction)
          await proveApiKey(pending, choice.providerId)
          await auth.credentials.modify(choice.providerId, async () => credential)
          // The credential is only reachable through a declared route, so the
          // sign-in is not finished until one exists.
          return await declareProviderRoute(ctx.get('settings'), choice.providerId)
        },
        stored: async (providerId) => {
          const credentials = ctx.get('credentials') as CodexCredentialService | undefined
          if (credentials === undefined) return undefined
          const record = await credentials.readRecord(recordKeyFor(providerId))
          if (record === undefined) return undefined
          return record.kind === 'api-key' ? 'api_key' : 'oauth'
        },
        reference: async (providerId) => {
          // A route this plugin mounts names its reference in this plugin's
          // config; every other route is whatever llm-pi-ai was configured
          // with, which is the same document a sign-in declares into.
          const ref = declaredCredentialRef(ctx.get('settings'), providerId)
            ?? (providerId === route.provider ? route.apiKeyEnv : undefined)
          if (ref === undefined || ref.length === 0) return undefined
          const credentials = ctx.get('credentials') as CredentialService | undefined
          if (credentials === undefined) return { ref }
          const info = await credentials.describe(ref)
          return { ref, ...info.configured && info.source !== undefined ? { source: info.source } : {} }
        },
        // Resolved per call, never at mount: a composition that mounts no
        // session UI still gets the command, and says so when it runs.
        ask: async (request) => {
          const userQuestions = ctx.get('userQuestions')
          if (userQuestions === undefined) {
            throw new Error('dsh-provider-extra: this composition mounts no session UI that can ask the sign-in questions')
          }
          return await userQuestions.ask({
            questions: [...request.questions],
            agent: request.agent,
            ...request.signal === undefined ? {} : { signal: request.signal },
          })
        },
      }
      commandCtx.commands.register(createLoginCommand(host, config.loginCommandName))
      // Registration is silent otherwise, and the command is the one surface a
      // user cannot see in a config dump: saying it exists is the diagnosis.
      ctx.logger.info('dsh-provider-extra: /' + config.loginCommandName + ' signs in any provider with an interactive login')
    })
  }
}
