/** RPC must retain the provider owner's capability and persistence boundaries. */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { mountTierRemote } from '../src/tier-remote.ts'
import { TIER_CONTRIBUTION, TIER_NAMESPACE, type TierView } from '../src/tier-client.ts'

const ROUTE = ['example-provider', 'example-model'] as const
const CHOICES = [{ id: 'priority', name: 'Fast', description: 'Higher usage cost; account access required' }]
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const WRITE_OUTCOMES = ['resolve', 'reject'] as const
const PRIVATE_FAILURE = '/private/example-provider-settings'
const CANCELLED_CODE = 'gateway/cancelled'
interface Remote { describe(provider: unknown, model: unknown, signal?: AbortSignal): Promise<TierView>; select(provider: unknown, model: unknown, tier?: unknown, signal?: AbortSignal): Promise<void> }

/** Owner identity the installed gateway exempts from the remote-access policy, as an in-process caller. */
const OWNER_PRINCIPAL = Object.freeze({ kind: 'owner' })
/** Peer id for the single in-process caller each test drives the gateway as. */
const OWNER_PEER_ID = 'tier-remote-owner'

/** Gateway invocation in the shape the specs drive: one method, its named arguments, and an optional cancellation. */
type GatewayInvoke = (method: string, args: unknown, signal?: AbortSignal) => Promise<unknown>

/**
 * The installed harness gateway, mounted the way the host composes it. The
 * 0.2.1 gateway injects remote access and requires every caller to name the
 * Peer it speaks for, so the specs call it as the owner over a live Peer: that
 * keeps the assertions on descriptor and argument validation rather than on a
 * policy this plugin does not own.
 * @param t - the test whose teardown releases the host services and the Peer.
 * @returns the host context and an owner-scoped invoker for the tier namespace.
 */
async function installedGateway(t: TestContext): Promise<{ ctx: Context; invoke: GatewayInvoke }> {
  const local = createRequire(import.meta.url)
  const cli = createRequire(local.resolve('@deepseek-ai/dsh/package.json'))
  const host = createRequire(cli.resolve('@deepseek-ai/dsh-web-app'))
  const load = (name: string) => import(pathToFileURL(host.resolve(name)).href)
  const [{ Context: HostContext }, { default: Registry }, { default: RemoteAccess }, { default: Gateway }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-typert-registry'), load('@deepseek-ai/dsh-api-remote-access'),
    load('@deepseek-ai/dsh-api-gateway'),
  ])
  const ctx: Context = new HostContext()
  const registry = await ctx.plugin(Registry)
  const access = await ctx.plugin(RemoteAccess)
  const gateway = await ctx.plugin(Gateway)
  const lifetime = new AbortController()
  t.after(async () => { lifetime.abort(); await gateway.dispose(); await access.dispose(); await registry.dispose() })
  const peer = Object.freeze({
    id: OWNER_PEER_ID, ctx, principal: OWNER_PRINCIPAL, signal: lifetime.signal, interactions: 'none',
    dispose: () => { lifetime.abort(); return Promise.resolve() },
  })
  const invoke: GatewayInvoke = (method, args, signal) => {
    const service = ctx.get('typertGateway') as { invoke(request: unknown): Promise<unknown> }
    return service.invoke({ namespace: TIER_NAMESPACE, method, args, peer, signal })
  }
  return { ctx, invoke }
}

test('optional remote mounts strict descriptors, validates writes, and disposes', async () => {
  const ctx = new Context()
  let registered = 0
  let current: string | undefined
  let fail = false
  let choices = CHOICES
  const writes: unknown[][] = []
  ctx.provide('typert', { register(contribution: { invocations: unknown }) {
    assert.equal(contribution.invocations, TIER_CONTRIBUTION.descriptors); registered++
    return async () => { registered-- }
  } } as never)
  ctx.provide('providerServiceTiers', { choices: () => choices, current: () => current,
    async select(...args: unknown[]) { if (fail) throw new Error('/private/token'); writes.push(args); current = args[2] as string | undefined } } as never)
  const fork = await ctx.plugin(mountTierRemote)
  await settle()
  assert.equal(registered, 1)
  const remote = ctx.get(TIER_NAMESPACE) as unknown as Remote
  assert.deepEqual(await remote.describe(...ROUTE), { choices: CHOICES })
  await remote.select(...ROUTE, 'priority')
  assert.equal((await remote.describe(...ROUTE)).current, 'priority')
  await remote.select(...ROUTE, undefined)
  assert.equal((await remote.describe(...ROUTE)).current, undefined)
  assert.deepEqual(writes, [[...ROUTE, 'priority'], [...ROUTE, undefined]])
  for (const value of ['', ' ', null, [], 3]) await assert.rejects(remote.describe(value, ROUTE[1]))
  await assert.rejects(remote.select(...ROUTE, 'fast'))
  choices = []
  await assert.rejects(remote.select(...ROUTE, undefined), /unsupported/i)
  choices = CHOICES
  fail = true
  await assert.rejects(remote.select(...ROUTE, 'priority'), error => error instanceof Error && !error.message.includes('/private'))
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(remote.select(...ROUTE, 'priority', cancelled.signal), { name: 'AbortError' })
  await fork.dispose()
  assert.equal(registered, 0)
  assert.equal(ctx.get(TIER_NAMESPACE), undefined)
})

test('installed gateway accepts strict descriptors and rejects malformed RPC arguments', async t => {
  const { ctx, invoke } = await installedGateway(t)
  let selected: string | undefined
  const calls: unknown[][] = []
  const provider = await ctx.plugin((owner: Context) => owner.provide('providerServiceTiers', {
    choices: () => CHOICES, current: () => selected,
    async select(...args: unknown[]) { calls.push(args); selected = args[2] as string | undefined },
  } as never))
  const remote = await ctx.plugin(mountTierRemote)
  t.after(async () => { await remote.dispose(); await provider.dispose() })
  await settle()
  const args = { provider: ROUTE[0], model: ROUTE[1] }
  assert.deepEqual(await invoke('describe', args), { choices: CHOICES })
  await invoke('select', { ...args, tier: 'priority' })
  assert.equal((await invoke('describe', args) as TierView).current, 'priority')
  await invoke('select', args)
  assert.equal(selected, undefined)
  for (const bad of [{ ...args, extra: true }, { ...args, provider: [] }, { provider: ROUTE[0] }, { ...args, tier: null }, { ...args, tier: 'fast' }]) {
    await assert.rejects(invoke('select', bad))
  }
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(invoke('select', { ...args, tier: 'priority' }, cancelled.signal))
  assert.deepEqual(calls, [[...ROUTE, 'priority'], [...ROUTE, undefined]])
  await remote.dispose()
  await assert.rejects(invoke('describe', args))
})

for (const outcome of WRITE_OUTCOMES) test('real gateway survives provider replacement while a submitted write will ' + outcome, async t => {
  const { ctx, invoke } = await installedGateway(t)
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  let finish!: () => void
  let fail!: (error: Error) => void
  const submitted = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
  let oldCurrent: string | undefined
  const first = await ctx.plugin((owner: Context) => owner.provide('providerServiceTiers', {
    choices: () => CHOICES, current: () => oldCurrent,
    async select(_provider: string, _model: string, tier: string | undefined) {
      start()
      await submitted
      oldCurrent = tier
    },
  } as never))
  const remote = await ctx.plugin(mountTierRemote)
  t.after(async () => { await remote.dispose(); await first.dispose() })
  await settle()
  const args = { provider: ROUTE[0], model: ROUTE[1] }
  const caller = new AbortController()
  const pending = invoke('select', { ...args, tier: 'priority' }, caller.signal)
  const rejected = assert.rejects(pending, { code: CANCELLED_CODE })
  await started
  caller.abort()
  await first.dispose()
  await assert.rejects(invoke('describe', args))

  let nextCurrent: string | undefined
  const nextCalls: unknown[][] = []
  const next = await ctx.plugin((owner: Context) => owner.provide('providerServiceTiers', {
    choices: () => CHOICES, current: () => nextCurrent,
    async select(...args: unknown[]) { nextCalls.push(args); nextCurrent = args[2] as string | undefined },
  } as never))
  t.after(() => next.dispose())
  await settle()
  assert.deepEqual(await invoke('describe', args), { choices: CHOICES })
  await invoke('select', { ...args, tier: 'priority' })
  assert.equal((await invoke('describe', args) as TierView).current, 'priority')
  assert.deepEqual(nextCalls, [[...ROUTE, 'priority']])

  if (outcome === 'resolve') finish()
  else fail(new Error(PRIVATE_FAILURE))
  await rejected
  // Client cancellation cannot undo an accepted provider persistence operation.
  assert.equal(oldCurrent, outcome === 'resolve' ? 'priority' : undefined)
  await invoke('select', args)
  assert.equal((await invoke('describe', args) as TierView).current, undefined)
  assert.deepEqual(nextCalls, [[...ROUTE, 'priority'], [...ROUTE, undefined]])
})

test('missing typert leaves provider-only hosts operational', async () => {
  const ctx = new Context()
  const fork = await ctx.plugin(mountTierRemote)
  await settle()
  assert.equal(ctx.get(TIER_NAMESPACE), undefined)
  await fork.dispose()
})
