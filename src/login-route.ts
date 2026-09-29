/**
 * Making a signed-in provider reachable.
 *
 * A sign-in stores a credential, but the harness serves a provider only through
 * a route its own pi-ai service has been configured with: signing into a
 * catalog provider the profile never declared stores a key that no request can
 * use, and the first turn then fails with "no adapter registered for provider",
 * which reads as a broken sign-in rather than the missing declaration it is.
 * The write below adds that declaration, because a human who just signed in
 * asked for a provider to work, not for a file to edit.
 *
 * @module dsh-provider-extra/login-route
 */

/** The namespace the harness pi-ai service owns; its providers dict is the route set. */
const PI_AI_SETTINGS_NAMESPACE = 'llm-pi-ai'

/** The dict whose keys are routes, matching that service's configuration shape. */
const PROVIDERS_FIELD = 'providers'

/** The entry field naming the credential reference a route resolves. */
const API_KEY_ENV_FIELD = 'apiKeyEnv'

/**
 * A catalog route needs no fields of its own: the installed catalog supplies
 * the endpoint, protocol, and models, and the credential is read from the store
 * this command already wrote, so an empty profile is the whole declaration.
 */
const CATALOG_ROUTE_OVERRIDES: Record<string, never> = {}

/** What one declaration found or did, so the caller can say it instead of assuming it. */
export type RouteDeclaration = 'declared' | 'present' | 'unavailable'

/** The slice of the settings service this needs, kept structural so its absence is a value, not a crash. */
export interface SettingsLike {
  get(namespace: typeof PI_AI_SETTINGS_NAMESPACE): unknown
  update(namespace: typeof PI_AI_SETTINGS_NAMESPACE, patch: object): Promise<void>
}

/**
 * The same slice, but only when the running line still owns a per-namespace
 * settings document.
 *
 * The 0.1.7 line publishes forms derived from each entry's own Config, and its
 * service has neither reader nor writer for a namespace: the declaration this
 * seam used to write is a profile-patch edit there. Reporting that as
 * unavailable is the truth, where handing the service through would fail on the
 * first read and read as a broken sign-in rather than a moved seam.
 *
 * @param service - whatever the composition publishes under the settings name.
 * @returns the readable-and-writable seam, or nothing on a line without one.
 */
export function legacySettings(service: unknown): SettingsLike | undefined {
  const settings = service as Partial<SettingsLike> | undefined
  return settings !== undefined && typeof settings.get === 'function' && typeof settings.update === 'function'
    ? settings as SettingsLike
    : undefined
}

/** The configured routes, or nothing when no pi-ai service registered the namespace. */
function configuredProviders(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const providers = (value as Record<string, unknown>)[PROVIDERS_FIELD]
  return typeof providers === 'object' && providers !== null ? providers as Record<string, unknown> : undefined
}

/**
 * The credential reference one declared route resolves, when its entry names
 * one. A route declared without the field authenticates from the credential
 * store instead, so it has no reference for a caller to report — and a route
 * whose reference is unset never falls back to a stored record, which is why
 * the reference alone answers what that route will use.
 *
 * @param settings - the settings service, absent in a composition that mounts none.
 * @param providerId - the pi-ai catalog provider whose route entry to read.
 * @returns the reference name, or nothing when the route names none.
 */
export function declaredCredentialRef(settings: SettingsLike | undefined, providerId: string): string | undefined {
  if (settings === undefined) return undefined
  const entry = configuredProviders(settings.get(PI_AI_SETTINGS_NAMESPACE))?.[providerId]
  if (typeof entry !== 'object' || entry === null) return undefined
  const ref = (entry as Record<string, unknown>)[API_KEY_ENV_FIELD]
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/**
 * Give a freshly stored credential a route to be read through.
 *
 * The patch names one provider, so the settings service merges it over the
 * routes a profile already configured and no existing key or override is
 * restated, let alone lost.
 *
 * @param settings - the settings service, absent in a composition that mounts none.
 * @param providerId - the pi-ai catalog provider that was just signed in.
 * @returns whether the route was added, already configured, or cannot exist here.
 */
export async function declareProviderRoute(settings: SettingsLike | undefined, providerId: string): Promise<RouteDeclaration> {
  if (settings === undefined) return 'unavailable'
  const providers = configuredProviders(settings.get(PI_AI_SETTINGS_NAMESPACE))
  if (providers === undefined) return 'unavailable'
  if (providers[providerId] !== undefined) return 'present'
  await settings.update(PI_AI_SETTINGS_NAMESPACE, { [PROVIDERS_FIELD]: { [providerId]: CATALOG_ROUTE_OVERRIDES } })
  return 'declared'
}
