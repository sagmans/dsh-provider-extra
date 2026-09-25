/**
 * Proving a pasted key before the profile remembers it.
 *
 * A login hands back whatever the human typed, and nothing in the credential
 * store tells a key the provider accepts from one it refuses: the difference
 * only surfaces on a later request, when the human has moved on and the failure
 * reads as a broken model. One minimal request, spent while the credential
 * still exists only in memory, replaces that guess with the provider's answer.
 */
import type { Credential, CredentialInfo, CredentialStore, Models } from '@earendil-works/pi-ai'

/** The smallest request that still carries the credential. */
const PROBE_PROMPT = 'ping'

/** One token is enough: the reply is never read, only the error channel is. */
const PROBE_MAX_TOKENS = 1

/** A provider that never answers must not hold a sign-in open. */
const PROBE_TIMEOUT_MS = 20_000

const PROBE_TIMEOUT = 'the provider did not answer in time'

/** Prefix that turns a provider's own words into the sentence a human reads. */
const REJECTED_PREFIX = 'the provider did not accept this API key: '

/** No model means no evidence, not a provider rejection or a successful proof. */
const NO_MODELS_PREFIX = 'cannot verify this API key: no models are available for provider '

/** The part of the collection a proof needs, so a test can answer for a provider. */
export type KeyProbe = Pick<Models, 'getModels' | 'completeSimple'>

/**
 * A credential store that forgets.
 *
 * A login writes what it collected as it goes, and the profile's store is the
 * only one pi-ai can be handed, so the sign-in runs against this instead and
 * the real store hears about the key only once the provider has answered for it.
 */
export class PendingCredentialStore implements CredentialStore {
  private readonly held = new Map<string, Credential>()

  async read(providerId: string): Promise<Credential | undefined> {
    return this.held.get(providerId)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.held].map(([providerId, credential]) => ({ providerId, type: credential.type }))
  }

  async modify(
    providerId: string,
    mutate: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await mutate(this.held.get(providerId))
    if (next !== undefined) this.held.set(providerId, next)
    return next
  }

  async delete(providerId: string): Promise<void> {
    this.held.delete(providerId)
  }
}

/**
 * Ask the provider whether the credential it was just given works.
 *
 * Throws the provider's own explanation when it refuses, so the human can tell
 * a mistyped key from a key that lacks a plan or a region.
 */
export async function proveApiKey(models: KeyProbe, providerId: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const model = models.getModels(providerId)[0]
  if (model === undefined) throw new Error(NO_MODELS_PREFIX + providerId)
  const deadline = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const probeSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  const answer = await models.completeSimple(
    model,
    { messages: [{ role: 'user', content: PROBE_PROMPT, timestamp: Date.now() }] },
    { maxTokens: PROBE_MAX_TOKENS, signal: probeSignal },
  )
  // A transport may finish despite cancellation; that answer must not authorize a key write.
  probeSignal.throwIfAborted()
  if (answer.stopReason !== 'error' && answer.stopReason !== 'aborted') return
  throw new Error(REJECTED_PREFIX + (answer.errorMessage ?? PROBE_TIMEOUT))
}
