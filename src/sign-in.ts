/**
 * Sign-in entry: mounts the Models-page authorization transport.
 *
 * A separate Loader entry, rather than a line in the route plugin, keeps the
 * transport independent of the catalog and additive route modes: the bundle
 * patch activates it once and it never competes with route registration.
 *
 * @module @sagmans/dsh-provider-extra/sign-in
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountProviderAuth } from './auth-remote.ts'

/** Loader identity for the sign-in entry. */
export const name = 'dsh-provider-extra-sign-in'

/**
 * Mount the transport beside whatever routes this plugin serves.
 * @param ctx - Host context; the transport parks itself when the harness has
 *   no authorization seam or Typert registry.
 */
export function apply(ctx: Context): void {
  mountProviderAuth(ctx)
}
