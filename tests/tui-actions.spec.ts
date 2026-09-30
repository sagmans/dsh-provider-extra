/** Provider-owned UI must commit paid policy before claiming success and remain optional. */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createTierPicker, mountTierActions, TIER_ACTION_ID, type TierActionPorts } from '../src/tui-actions.ts'
import type { TierSelection } from '../src/service-tiers.ts'

const PROVIDER = 'openai-codex'
const MODEL = 'gpt-5.6-luna'
const PRIORITY = 'priority'
const CHOICES = [{ id: PRIORITY, name: 'Fast', description: 'Higher usage cost' }]
const ROUTE = { provider: PROVIDER, model: MODEL }

/** Public generic ports keep the provider test independent of terminal implementation classes. */
function harness(picked: string | undefined, available = true, failure = false) {
  const calls: unknown[][] = []
  const notices: string[] = []
  let picks = 0
  const tiers: TierSelection = { choices: () => available ? CHOICES : [], current: () => undefined,
    select: async (...args) => { if (failure) throw new Error('private adapter details'); calls.push(args) } }
  const ports: TierActionPorts = { route: ROUTE, pick: async spec => { picks++; assert.equal(spec.rows[0]!.id, ''); return picked }, notice: text => notices.push(text) }
  return { tiers, ports, choose: createTierPicker(tiers), calls, notices, picks: () => picks }
}

it('saves the selected paid policy and reports only committed success', async () => {
  const test = harness(PRIORITY)
  await test.choose(test.ports)
  assert.deepEqual(test.calls, [[PROVIDER, MODEL, PRIORITY]])
  assert.match(test.notices.at(-1)!, /set to priority/)
})
it('clears explicit policy and leaves cancellation untouched', async () => {
  const cleared = harness('')
  await cleared.choose(cleared.ports)
  assert.deepEqual(cleared.calls, [[PROVIDER, MODEL, undefined]])
  const cancelled = harness(undefined)
  await cancelled.choose(cancelled.ports)
  assert.deepEqual(cancelled.calls, [])
  assert.deepEqual(cancelled.notices, [])
})
it('skips unsupported follow-ups while direct invocation explains the missing capability', async () => {
  const test = harness(PRIORITY, false)
  await test.choose(test.ports, true)
  assert.deepEqual(test.notices, [])
  await test.choose(test.ports)
  assert.match(test.notices[0]!, /advertises no service tiers/)
  assert.equal(test.picks(), 0)
})
it('does not leak adapter details or report a failed write as success', async () => {
  const test = harness(PRIORITY, true, true)
  await test.choose(test.ports)
  assert.deepEqual(test.calls, [])
  assert.deepEqual(test.notices, ['could not save service tier; check writable provider settings and retry'])
})
it('owns the default chord and effort follow-up for its injection lifetime', async t => {
  const ctx = new Context()
  const actions: { id: string; defaultKeys: readonly string[]; handler(ports: TierActionPorts): Promise<void> }[] = []
  const hooks = new Set<(ports: TierActionPorts) => Promise<void>>()
  const registry = {
    register: (owner: Context, action: typeof actions[number]) => owner.effect(() => { actions.push(action); return () => { actions.splice(actions.indexOf(action), 1) } }),
    afterEffort: (owner: Context, handler: (ports: TierActionPorts) => Promise<void>) => owner.effect(() => { hooks.add(handler); return () => { hooks.delete(handler) } }),
  }
  const surface = await ctx.plugin((owner: Context) => owner.provide('tuiKeymaps', registry as never))
  t.after(() => surface.dispose())
  const test = harness(PRIORITY)
  const owner = await ctx.plugin((owner: Context) => mountTierActions(owner, test.tiers))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(actions.length, 1)
  assert.equal(actions[0]!.id, TIER_ACTION_ID)
  assert.deepEqual(actions[0]!.defaultKeys, ['t'])
  assert.equal(hooks.size, 1)
  await actions[0]!.handler(test.ports)
  assert.deepEqual(test.calls, [[PROVIDER, MODEL, PRIORITY]])
  await owner.dispose()
  assert.equal(actions.length, 0)
  assert.equal(hooks.size, 0)
})
