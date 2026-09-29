/** Harness matrix rules: the range, the verified list, and what each package may declare. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { checkMatrix, compareVersions } from '../tools/harness-matrix.mjs'

const RANGE = '>=0.1.5-rc.1 <0.2.0'
const RELEASES = ['0.1.5-rc.2', '0.1.5-rc.3', '0.1.7-rc.2']

/** A manifest that satisfies every rule, so one rule can be broken at a time. */
function consistent(overrides = {}) {
  return {
    dsh: { compatibility: { dsh: RANGE, dshReleases: Object.fromEntries(RELEASES.map(release => [release, 'compatible'])) } },
    peerDependencies: { '@deepseek-ai/dsh-llm': '*', '@deepseek-ai/cordis': '^4.0.2' },
    devDependencies: { '@deepseek-ai/dsh-llm': '0.1.7-rc.2' },
    ...overrides,
  }
}

test('the shipped manifest satisfies the matrix', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(checkMatrix(manifest), [])
})

test('a release outside the compatible range is refused', () => {
  const manifest = consistent()
  manifest.dsh.compatibility.dshReleases['0.2.0'] = 'compatible'
  assert.equal(checkMatrix(manifest).length, 1)
  assert.match(checkMatrix(manifest)[0], /verified release 0\.2\.0 lies outside the compatible range/u)
})

test('a range no plugin can parse, and an empty verified list, are both refused', () => {
  assert.match(checkMatrix(consistent({ dsh: { compatibility: { dsh: '^0.1.5', dshReleases: {} } } }))[0], /must declare a ">=lower <upper" range/u)
  assert.match(checkMatrix(consistent({ dsh: { compatibility: { dsh: RANGE, dshReleases: {} } } }))[0], /must name at least one verified release/u)
})

test('a harness peer stays open, and a narrowed one is refused', () => {
  assert.deepEqual(checkMatrix(consistent({ peerDependencies: { '@deepseek-ai/dsh-llm': RANGE } })), [])
  assert.deepEqual(checkMatrix(consistent({ peerDependencies: { '@deepseek-ai/dsh-llm': '0.1.7-rc.2' } })), [])
  // The range that cannot admit a 0.1.7 prerelease is exactly the one a peer
  // must not carry, or a 0.1.7 profile resolves a second framework copy.
  const narrowed = consistent({ peerDependencies: { '@deepseek-ai/dsh-llm': '0.1.7-rc.1' } })
  assert.match(checkMatrix(narrowed)[0], /peer dependency @deepseek-ai\/dsh-llm declares 0\.1\.7-rc\.1/u)
  // A non-harness package keeps its own range: the rule places harness rows.
  assert.deepEqual(checkMatrix(consistent({ peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } })), [])
})

test('a mounted harness package follows the same placing rule', () => {
  assert.deepEqual(checkMatrix(consistent({ dependencies: { '@deepseek-ai/dsh-llm': RANGE, 'commander': '^15.0.0' } })), [])
  const pinned = consistent({ dependencies: { '@deepseek-ai/dsh-llm': '0.1.7-rc.1' } })
  assert.match(checkMatrix(pinned)[0], /mounted package @deepseek-ai\/dsh-llm/u)
})

test('an aliased install names a verified release', () => {
  const aliased = consistent({ dependencies: { '@sagmans/dsh-llm-017': 'npm:@deepseek-ai/dsh-llm@0.1.7-rc.2' } })
  assert.deepEqual(checkMatrix(aliased), [])
  const unreached = consistent({ dependencies: { '@sagmans/dsh-llm-017': 'npm:@deepseek-ai/dsh-llm@0.1.6-alpha.2' } })
  assert.match(checkMatrix(unreached)[0], /aliased dependency/u)
})

test('the sources compile against exactly one verified release', () => {
  const two = consistent({ devDependencies: { '@deepseek-ai/dsh-llm': '0.1.7-rc.2', '@deepseek-ai/dsh-settings': '0.1.5-rc.3' } })
  assert.match(checkMatrix(two)[0], /name 2 versions, not one/u)
  const unverified = consistent({ devDependencies: { '@deepseek-ai/dsh-llm': '0.1.5-rc.1' } })
  assert.match(checkMatrix(unverified)[0], /which is not a verified release/u)
  assert.match(checkMatrix(consistent({ devDependencies: {} }))[0], /compiles against no harness package/u)
})

test('a prerelease orders before its own release and after the previous one', () => {
  assert.ok(compareVersions('0.1.5-rc.3', '0.1.7-rc.2') < 0)
  assert.ok(compareVersions('0.1.7-rc.2', '0.1.7') < 0)
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0') < 0)
  assert.equal(compareVersions('0.1.5-rc.2', '0.1.5-rc.2'), 0)
  assert.throws(() => compareVersions('0.1', '0.2.0'), /unsupported version/u)
})
