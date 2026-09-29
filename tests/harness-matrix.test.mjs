/** Harness matrix rules: the range, the verified list, and what each package may declare. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { admitsVersion, checkMatrix, compareVersions } from '../tools/harness-matrix.mjs'

const RANGE = '>=0.1.5-rc.1 <0.3.0'
const RELEASES = ['0.1.5-rc.2', '0.1.5-rc.3', '0.1.7-rc.2', '0.2.0-rc.2']
/** The vendor peer that admits both model-adapter lines those releases ship. */
const VENDOR_PEER = '^0.85.1 || ^0.87.1'

/** A manifest that satisfies every rule, so one rule can be broken at a time. */
function consistent(overrides = {}) {
  // Peers merge rather than replace, because the vendor rule is about one entry
  // and a case that narrows another peer must not silently drop it.
  const { peerDependencies, ...rest } = overrides
  return {
    dsh: { compatibility: { dsh: RANGE, dshReleases: Object.fromEntries(RELEASES.map(release => [release, 'compatible'])) } },
    devDependencies: { '@deepseek-ai/dsh-llm': '0.1.7-rc.2' },
    ...rest,
    peerDependencies: { '@deepseek-ai/dsh-llm': '*', '@deepseek-ai/cordis': '^4.0.2', '@earendil-works/pi-ai': VENDOR_PEER, ...peerDependencies },
  }
}

test('the shipped manifest satisfies the matrix', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(checkMatrix(manifest), [])
})

test('a release outside the compatible range is refused', () => {
  const manifest = consistent()
  manifest.dsh.compatibility.dshReleases['0.3.0'] = 'compatible'
  // One rule per problem: the unrecorded release reports its own, so the range
  // rule is asserted by its message rather than by counting the list.
  assert.ok(checkMatrix(manifest).some(problem => /verified release 0\.3\.0 lies outside the compatible range/u.test(problem)))
})

test('a range no plugin can parse, and an empty verified list, are both refused', () => {
  assert.match(checkMatrix(consistent({ dsh: { compatibility: { dsh: '^0.1.5', dshReleases: {} } } }))[0], /must declare a ">=lower <upper" range/u)
  assert.match(checkMatrix(consistent({ dsh: { compatibility: { dsh: RANGE, dshReleases: {} } } }))[0], /must name at least one verified release/u)
})

test('a harness peer stays open, and a narrowed one is refused', () => {
  assert.deepEqual(checkMatrix(consistent({ peerDependencies: { '@deepseek-ai/dsh-llm': RANGE } })), [])
  assert.deepEqual(checkMatrix(consistent({ peerDependencies: { '@deepseek-ai/dsh-llm': '0.1.7-rc.2' } })), [])
  // A peer naming one prerelease line is exactly what a profile on another line
  // must not carry: npm admits a prerelease only through a comparator naming its
  // own tuple, so that peer resolves a second framework copy beside the host's.
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

test('a vendor peer admits every version the served lines ship', () => {
  assert.deepEqual(checkMatrix(consistent()), [])
  // The plugin builds a provider out of this vendor and hands it to the host's
  // seam, so a peer that admits one line and not the other resolves a private
  // copy of the vendor under the plugin — the shape that failed the 0.2.0 turn.
  const narrowed = consistent({ peerDependencies: { '@earendil-works/pi-ai': '^0.85.1' } })
  assert.match(checkMatrix(narrowed)[0], /peer dependency @earendil-works\/pi-ai declares \^0\.85\.1, which does not admit 0\.87\.1, the vendor line 0\.2\.0-rc\.2 ships/u)
  const opened = consistent({ peerDependencies: { '@earendil-works/pi-ai': '*' } })
  assert.deepEqual(checkMatrix(opened), [])
  // A range this guard cannot read is reported, never read as an admission.
  const unreadable = consistent({ peerDependencies: { '@earendil-works/pi-ai': '>=0.85.1' } })
  assert.match(checkMatrix(unreadable)[0], /which this guard cannot verify against the 0\.85\.1 line 0\.1\.5-rc\.2 ships/u)
  const dropped = consistent()
  delete dropped.peerDependencies['@earendil-works/pi-ai']
  assert.match(checkMatrix(dropped)[0], /peer dependency @earendil-works\/pi-ai is missing/u)
  // A new verified line cannot skip the vendor question.
  const unrecorded = consistent()
  unrecorded.dsh.compatibility.dshReleases['0.2.0-rc.3'] = 'compatible'
  assert.match(checkMatrix(unrecorded)[0], /verified release 0\.2\.0-rc\.3 has no recorded vendor pin/u)
})

test('a caret keeps the minor of a 0.x vendor line', () => {
  assert.ok(admitsVersion('^0.85.1 || ^0.87.1', '0.85.1'))
  assert.ok(admitsVersion('^0.85.1 || ^0.87.1', '0.87.1'))
  assert.ok(admitsVersion('^0.87.1', '0.87.2'))
  assert.ok(!admitsVersion('^0.85.1', '0.87.1'))
  assert.ok(!admitsVersion('^0.85.1', '0.86.0'))
  assert.ok(admitsVersion('0.87.1', '0.87.1'))
  assert.ok(admitsVersion('*', '0.87.1'))
})

test('a prerelease orders before its own release and after the previous one', () => {
  assert.ok(compareVersions('0.1.5-rc.3', '0.1.7-rc.2') < 0)
  assert.ok(compareVersions('0.1.7-rc.2', '0.1.7') < 0)
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0') < 0)
  assert.equal(compareVersions('0.1.5-rc.2', '0.1.5-rc.2'), 0)
  assert.throws(() => compareVersions('0.1', '0.2.0'), /unsupported version/u)
})
