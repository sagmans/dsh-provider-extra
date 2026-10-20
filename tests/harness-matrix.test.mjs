/** Harness matrix rules: the range, the verified list, and what each package may declare. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { admitsVersion, checkMatrix, compareVersions, satisfiesRange } from '../tools/harness-matrix.mjs'

const RANGE = '>=0.2.1-rc.1 <0.3.0-0'
const RELEASES = ['0.2.1-rc.2']
/** The vendor peer that admits the model-adapter line those releases ship. */
const VENDOR_PEER = '>=1.1.0 <1.4.0'

/** A manifest that satisfies every rule, so one rule can be broken at a time. */
function consistent(overrides = {}) {
  // Peers merge rather than replace, because the vendor rule is about one entry
  // and a case that narrows another peer must not silently drop it.
  const { peerDependencies, ...rest } = overrides
  return {
    dsh: { compatibility: { dsh: RANGE, dshReleases: Object.fromEntries(RELEASES.map(release => [release, 'compatible'])) } },
    devDependencies: { '@deepseek-ai/dsh-llm': '0.2.1-rc.2' },
    ...rest,
    peerDependencies: { '@deepseek-ai/dsh-llm': RANGE, '@deepseek-ai/cordis': '^4.0.5', '@earendil-works/pi-ai': VENDOR_PEER, ...peerDependencies },
  }
}

test('the shipped manifest satisfies the matrix', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(checkMatrix(manifest), [])
})

test('a release outside the compatible range is refused', () => {
  // One rule per problem: the unrecorded release reports its own, so the range
  // rule is asserted by its message rather than by counting the list.
  for (const release of ['0.3.0', '0.3.0-rc.1']) {
    const manifest = consistent()
    manifest.dsh.compatibility.dshReleases[release] = 'compatible'
    const pattern = new RegExp('verified release ' + release.replaceAll('.', '\\.') + ' lies outside the compatible range', 'u')
    assert.ok(checkMatrix(manifest).some(problem => pattern.test(problem)))
  }
})

test('a range no plugin can parse, an open upper bound, and an empty verified list are all refused', () => {
  assert.match(checkMatrix(consistent({ dsh: { compatibility: { dsh: '^0.2.1', dshReleases: {} } } }))[0], /must declare ">=lower <upper" alternatives/u)
  assert.match(checkMatrix(consistent({ dsh: { compatibility: { dsh: RANGE, dshReleases: {} } } }))[0], /must name at least one verified release/u)
  // The dsh plugin gate reads prereleases anywhere inside the range, so a bare
  // upper bound admits the next line's release candidates.
  const open = consistent({ dsh: { compatibility: { dsh: '>=0.2.1-rc.1 <0.3.0', dshReleases: { '0.2.1-rc.2': 'compatible' } } } })
  assert.match(checkMatrix(open)[0], /bounds a line at <0\.3\.0, .* bound it at <0\.3\.0-0/u)
  // npm's strict peer resolution admits a prerelease only through a comparator
  // naming its own tuple, so a spanning range must give each line its own.
  const spanning = '>=0.2.0-rc.1 <0.3.0-0'
  const unreachable = consistent({ dsh: { compatibility: { dsh: spanning, dshReleases: { '0.2.1-rc.2': 'compatible' } } },
    peerDependencies: { '@deepseek-ai/dsh-llm': spanning } })
  assert.match(checkMatrix(unreachable)[0], /verified release 0\.2\.1-rc\.2 is a prerelease npm peer resolution refuses/u)
})

test('a harness peer carries the range, and open or narrowed ones are refused', () => {
  assert.deepEqual(checkMatrix(consistent({ peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.1-rc.2' } })), [])
  // An open peer is what the dsh plugin gate reads as admitting every host,
  // including lines whose vendor this plugin cannot serve.
  assert.match(checkMatrix(consistent({ peerDependencies: { '@deepseek-ai/dsh-llm': '*' } }))[0],
    /peer dependency @deepseek-ai\/dsh-llm declares \*/u)
  // A peer naming one prerelease line is exactly what a profile on another line
  // must not carry: npm admits a prerelease only through a comparator naming its
  // own tuple, so that peer resolves a second framework copy beside the host's.
  const narrowed = consistent({ peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.1-rc.1' } })
  assert.match(checkMatrix(narrowed)[0], /peer dependency @deepseek-ai\/dsh-llm declares 0\.2\.1-rc\.1/u)
  // A non-harness package keeps its own range: the rule places harness rows.
  assert.deepEqual(checkMatrix(consistent({ peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } })), [])
})

test('a mounted harness package follows the same placing rule', () => {
  assert.deepEqual(checkMatrix(consistent({ dependencies: { '@deepseek-ai/dsh-llm': RANGE, 'commander': '^15.0.0' } })), [])
  const pinned = consistent({ dependencies: { '@deepseek-ai/dsh-llm': '0.2.1-rc.1' } })
  assert.match(checkMatrix(pinned)[0], /mounted package @deepseek-ai\/dsh-llm/u)
})

test('an aliased install names a verified release', () => {
  const aliased = consistent({ dependencies: { '@sagmans/dsh-llm-021': 'npm:@deepseek-ai/dsh-llm@0.2.1-rc.2' } })
  assert.deepEqual(checkMatrix(aliased), [])
  const unreached = consistent({ dependencies: { '@sagmans/dsh-llm-021': 'npm:@deepseek-ai/dsh-llm@0.2.1-alpha.5' } })
  assert.match(checkMatrix(unreached)[0], /aliased dependency/u)
})

test('the sources compile against exactly one verified release', () => {
  const two = consistent({ devDependencies: { '@deepseek-ai/dsh-llm': '0.2.1-rc.2', '@deepseek-ai/dsh-settings': '0.2.1-rc.1' } })
  assert.match(checkMatrix(two)[0], /name 2 versions, not one/u)
  const unverified = consistent({ devDependencies: { '@deepseek-ai/dsh-llm': '0.2.1-rc.1' } })
  assert.match(checkMatrix(unverified)[0], /which is not a verified release/u)
  assert.match(checkMatrix(consistent({ devDependencies: {} }))[0], /compiles against no harness package/u)
})

test('a vendor peer admits every version the served lines ship', () => {
  assert.deepEqual(checkMatrix(consistent()), [])
  // The plugin builds a provider out of this vendor and hands it to the host's
  // seam, so a peer that excludes the line's vendor resolves a private copy of
  // it under the plugin — the shape that failed the 0.2.0 turn.
  const narrowed = consistent({ peerDependencies: { '@earendil-works/pi-ai': '>=1.1.0 <1.3.0' } })
  assert.match(checkMatrix(narrowed)[0], /peer dependency @earendil-works\/pi-ai declares >=1\.1\.0 <1\.3\.0, which does not admit 1\.3\.0, the vendor line 0\.2\.1-rc\.2 ships/u)
  const opened = consistent({ peerDependencies: { '@earendil-works/pi-ai': '*' } })
  assert.deepEqual(checkMatrix(opened), [])
  // A range with no upper bound admits vendor minors nobody verified, and is
  // reported rather than read as an admission.
  const unbounded = consistent({ peerDependencies: { '@earendil-works/pi-ai': '>=1.1.0' } })
  assert.match(checkMatrix(unbounded)[0], /which this guard cannot verify against the 1\.3\.0 line 0\.2\.1-rc\.2 ships/u)
  const dropped = consistent()
  delete dropped.peerDependencies['@earendil-works/pi-ai']
  assert.match(checkMatrix(dropped)[0], /peer dependency @earendil-works\/pi-ai is missing/u)
  // A new verified line cannot skip the vendor question.
  const unrecorded = consistent()
  unrecorded.dsh.compatibility.dshReleases['0.2.1-rc.3'] = 'compatible'
  assert.match(checkMatrix(unrecorded)[0], /verified release 0\.2\.1-rc\.3 has no recorded vendor pin/u)
})

test('a caret keeps the minor of a 0.x vendor line, and a bounded range stops at its upper bound', () => {
  assert.ok(admitsVersion('^0.85.1 || ^0.87.1', '0.85.1'))
  assert.ok(admitsVersion('^0.85.1 || ^0.87.1', '0.87.1'))
  assert.ok(admitsVersion('^0.87.1', '0.87.2'))
  assert.ok(!admitsVersion('^0.85.1', '0.87.1'))
  assert.ok(!admitsVersion('^0.85.1', '0.86.0'))
  assert.ok(admitsVersion('0.87.1', '0.87.1'))
  assert.ok(admitsVersion('*', '0.87.1'))
  assert.ok(admitsVersion(VENDOR_PEER, '1.3.0'))
  assert.ok(!admitsVersion(VENDOR_PEER, '1.4.0'))
  // The two readers of the harness range disagree only on prereleases.
  assert.ok(satisfiesRange(RANGE, '0.2.1-rc.2'))
  assert.ok(!satisfiesRange(RANGE, '0.2.2-rc.1'))
  assert.ok(satisfiesRange(RANGE, '0.2.2-rc.1', { includePrerelease: true }))
  assert.ok(!satisfiesRange(RANGE, '0.3.0-rc.1', { includePrerelease: true }))
})

test('a prerelease orders before its own release and after the previous one', () => {
  assert.ok(compareVersions('0.1.5-rc.3', '0.1.7-rc.2') < 0)
  assert.ok(compareVersions('0.1.7-rc.2', '0.1.7') < 0)
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0') < 0)
  assert.ok(compareVersions('0.3.0-0', '0.3.0-alpha.1') < 0)
  assert.ok(compareVersions('0.2.1-rc.2', '0.3.0-0') < 0)
  assert.equal(compareVersions('0.1.5-rc.2', '0.1.5-rc.2'), 0)
  assert.throws(() => compareVersions('0.1', '0.2.0'), /unsupported version/u)
})
