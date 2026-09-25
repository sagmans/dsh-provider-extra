/** Authentication owns credentials; only legacy discovery may also declare a route. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialKey, CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import { LlmError, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthInteraction, Provider } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { CatalogSnapshot } from './catalog.ts'
import { codexAuth, recordKeyFor } from './codex.ts'
import type { CodexCredentialService } from './codex.ts'
import { createLoginCommand } from './login-command.ts'
import { StoredCredentialError } from './login-contract.ts'
import type { LoginAuthType, LoginChoice, LoginCommandHost } from './login-contract.ts'
import { declareProviderRoute, declaredCredentialRef } from './login-route.ts'
import { PendingCredentialStore, proveApiKey } from './login-verify.ts'

const PLUGIN_NAME = 'dsh-provider-extra'
const GO_SOURCE = 'opencode-go'
const CODEX_SOURCE = 'openai-codex'
const MISSING_STORE = 'This composition has no writable credentials service; mount dsh-credentials-local before signing in.'
const READ_ONLY = 'The configured credential is read-only; change its supplying source before signing in.'

/** Structural capability checks keep unsupported hosts from collecting a credential they cannot save. */
interface Credentials extends CodexCredentialService {
  resolve(ref: string): Promise<{ value: string } | undefined>
  describe(ref: string): Promise<CredentialInfo>
  set?(ref: string, value: string): Promise<void>
  describeRecord?(key: CredentialKey): Promise<CredentialRecordInfo>
}

/** Source choices remain compatible in legacy mode; managed choices name exact route IDs. */
interface Target {
  id: string
  provider: Provider
  /** Absent for a catalog route that carries no credential of its own. */
  auth?: { apiKeyRef: string } | { credentialProvider: string }
  served: boolean
}

/** Registration knobs belong to the plugin Config, not a second settings namespace. */
export interface LoginConfig {
  loginCommandEnabled: boolean
  loginCommandName: string
  routeId: string
  codexRouteId: string
  apiKeyEnv: string
}

/** Captured managed snapshots stay authoritative while legacy overlays resolve per attempt. */
interface LoginRoutes {
  profiles(): ReadonlyMap<string, ResolvedPiAiProviderProfile>
  catalog?: CatalogSnapshot
  requireOwnership?: () => void
}

/** Profile headers are adapter-owned defaults, so direct proof must carry them too. */
function loginProvider(profile: ResolvedPiAiProviderProfile | undefined, fallback: Provider): Provider {
  const provider = profile?.piProvider ?? fallback
  if (profile?.headers === undefined) return provider
  return { ...provider,
    stream: (model, context, options) => provider.stream(model, context, { ...options, headers: { ...profile.headers, ...options?.headers } } as typeof options),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, { ...options, headers: { ...profile.headers, ...options?.headers } }),
  }
}

/** Managed membership and legacy catalog discovery deliberately choose different target sets. */
function loginTargets(ctx: Context, config: LoginConfig, routes: LoginRoutes): Target[] {
  const profiles = routes.profiles()
  if (routes.catalog !== undefined) {
    return [...routes.catalog.providers.values()].map(route => ({
      id: route.id, provider: profiles.get(route.id)!.piProvider!, auth: route.auth, served: true,
    }))
  }
  return builtinProviders().map(source => {
    const profile = source.id === GO_SOURCE ? profiles.get(config.routeId)
      : source.id === CODEX_SOURCE ? profiles.get(config.codexRouteId) : undefined
    // The plugin's Go adapter resolves its Config reference before considering any provider record.
    const ref = source.id === GO_SOURCE ? config.apiKeyEnv
      : source.id === CODEX_SOURCE && profile !== undefined ? undefined : declaredCredentialRef(ctx.get('settings'), source.id)
    // Legacy Codex aliases intentionally own a separate record; their command must use that same address.
    const credentialProvider = source.id === CODEX_SOURCE && profile !== undefined ? profile.provider : source.id
    return { id: source.id, provider: loginProvider(profile, source), served: profile !== undefined,
      auth: ref === undefined ? { credentialProvider } : { apiKeyRef: ref },
    }
  })
}

/** A named reference can hold only one API key, never an OAuth grant. */
function choicesFor(targets: readonly Target[]): LoginChoice[] {
  return targets.flatMap(target => {
    const choices: LoginChoice[] = []
    const oauth = target.provider.auth?.oauth
    if (target.auth !== undefined && 'credentialProvider' in target.auth && oauth?.login !== undefined) {
      choices.push({ providerId: target.id, providerName: target.provider.name, authType: 'oauth', methodLabel: oauth.loginLabel ?? oauth.name })
    }
    const apiKey = target.provider.auth?.apiKey
    if (apiKey?.login !== undefined) {
      choices.push({ providerId: target.id, providerName: target.provider.name, authType: 'api_key', methodLabel: apiKey.name })
    }
    return choices
  })
}

/** Checking writability before a prompt avoids obtaining grants the composition cannot retain. */
async function writableStore(ctx: Context, target: Target): Promise<Credentials> {
  const credentials = ctx.get('credentials') as Credentials | undefined
  if (credentials === undefined) throw new LlmError(MISSING_STORE, 'NO_CREDENTIAL_STORE')
  if (target.auth === undefined) throw new LlmError('This route names no credential to store', 'UNSUPPORTED_CREDENTIAL')
  if ('apiKeyRef' in target.auth) {
    if (typeof credentials.set !== 'function' || typeof credentials.describe !== 'function') {
      throw new LlmError(MISSING_STORE, 'NO_CREDENTIAL_STORE')
    }
    if (!(await credentials.describe(target.auth.apiKeyRef)).writable) throw new LlmError(READ_ONLY, 'READ_ONLY_CREDENTIAL')
  } else {
    if (typeof credentials.modifyRecord !== 'function' || typeof credentials.readRecord !== 'function') {
      throw new LlmError(MISSING_STORE, 'NO_CREDENTIAL_STORE')
    }
    const info = await credentials.describeRecord?.(recordKeyFor(target.auth.credentialProvider))
    if (info?.writable === false) throw new LlmError(READ_ONLY, 'READ_ONLY_CREDENTIAL')
  }
  return credentials
}

/** OAuth crosses the durability boundary before any later cancellation or ownership verdict. */
async function authenticate(target: Target, method: LoginAuthType, credentials: Credentials, interaction: AuthInteraction, guard: () => void): Promise<void> {
  const auth = codexAuth(() => credentials)
  const signal = interaction.signal ?? new AbortController().signal
  signal.throwIfAborted()
  guard()
  if (method === 'oauth' && target.auth !== undefined && 'credentialProvider' in target.auth) {
    // The flow owns cancellation until it returns a grant; then persistence owns completion.
    const grant = await target.provider.auth.oauth!.login!({ ...interaction, signal })
    await auth.credentials.modify(target.auth.credentialProvider, async () => grant)
    return
  }
  const pending = createModels({ credentials: new PendingCredentialStore(), authContext: auth.authContext })
  pending.setProvider(target.provider)
  const credential = await pending.login(target.provider.id, 'api_key', interaction)
  guard()
  await proveApiKey(pending, target.provider.id, signal)
  signal.throwIfAborted()
  guard()
  if (target.auth !== undefined && 'apiKeyRef' in target.auth) {
    if (credential.type !== 'api_key' || credential.key === undefined) {
      throw new LlmError('This login did not return a single API key for ' + target.auth.apiKeyRef, 'UNSUPPORTED_CREDENTIAL')
    }
    const ref = credentialRef(target.auth.apiKeyRef)
    const key = assertUsableApiKey(credential.key, PLUGIN_NAME, ref)
    // set() is atomic but not cancellable; once it starts, report the resulting durable state.
    await credentials.set!(ref, key)
    try {
      if ((await credentials.resolve(ref))?.value !== key) {
        throw new Error(ref + ' does not resolve to the saved key.')
      }
    } catch (error) {
      throw new StoredCredentialError('The credential was stored, but readback failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  } else {
    if (target.auth === undefined) throw new LlmError('This route names no credential to store', 'UNSUPPORTED_CREDENTIAL')
    await auth.credentials.modify(target.auth.credentialProvider, async () => {
      // A queued record update can still stop before its locked mutation begins.
      signal.throwIfAborted()
      guard()
      return credential
    })
  }
}

/** Both modes share the attended conversation without sharing route-declaration authority. */
export function mountLoginCommand(ctx: Context, config: LoginConfig, routes: LoginRoutes): void {
  if (!config.loginCommandEnabled) return
  ctx.inject(['commands'], commandCtx => {
    const targets = () => loginTargets(ctx, config, routes)
    const targetFor = (id: string): Target => {
      const target = targets().find(target => target.id === id)
      if (target === undefined) throw new Error('The configured sign-in route is no longer available: ' + id)
      return target
    }
    const guard = routes.requireOwnership ?? (() => {})
    const host: LoginCommandHost = {
      choices: () => choicesFor(targets()),
      login: async (choice, interaction) => {
        guard()
        const target = targetFor(choice.providerId)
        const credentials = await writableStore(ctx, target)
        await authenticate(target, choice.authType, credentials, interaction, guard)
        try { guard() } catch (error) {
          throw new StoredCredentialError('The credential was stored, but the route is unavailable: ' + (error instanceof Error ? error.message : String(error)))
        }
        if (routes.catalog !== undefined || target.served) return 'present'
        if (interaction.signal?.aborted) return 'unavailable'
        return declareProviderRoute(ctx.get('settings'), target.id)
      },
      stored: async id => {
        const target = targetFor(id)
        const credentials = ctx.get('credentials') as Credentials | undefined
        if (target.auth === undefined) return undefined
        if ('apiKeyRef' in target.auth) {
          return (await credentials?.resolve(target.auth.apiKeyRef)) === undefined ? undefined : 'api_key'
        }
        const record = await credentials?.readRecord(recordKeyFor(target.auth.credentialProvider))
        return record === undefined ? undefined : record.kind === 'api-key' ? 'api_key' : 'oauth'
      },
      reference: async id => {
        const target = targetFor(id)
        if (target.auth === undefined || !('apiKeyRef' in target.auth)) return undefined
        const ref = target.auth.apiKeyRef
        const credentials = ctx.get('credentials') as Credentials | undefined
        if (credentials === undefined) return { ref, ...(process.env[ref] ? { source: 'env' } : {}) }
        const info = await credentials.describe(ref)
        return { ref, ...(info.configured && info.source !== undefined ? { source: info.source } : {}) }
      },
      ask: async request => {
        const userQuestions = ctx.get('userQuestions')
        if (userQuestions === undefined) throw new Error('dsh-provider-extra: this composition mounts no session UI that can ask the sign-in questions')
        return userQuestions.ask({ questions: [...request.questions], agent: request.agent,
          ...(request.signal === undefined ? {} : { signal: request.signal }) })
      },
    }
    commandCtx.commands.register(createLoginCommand(host, config.loginCommandName))
    ctx.logger.info('dsh-provider-extra: /' + config.loginCommandName + ' signs in configured credentials')
  })
}
