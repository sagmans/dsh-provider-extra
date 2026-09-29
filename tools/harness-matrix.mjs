#!/usr/bin/env node
/**
 * Harness matrix guard.
 *
 * This plugin's peers accept one compatible harness range while its sources
 * compile against a single verified release, and a tree where those disagree —
 * a peer narrowed to the pinned release, or a verified list naming a release the
 * sources never compiled against — is how an install resolves a private second
 * copy of the framework instead of the host's. The default mode checks the
 * matrix offline; --check-registry also reads the registry's latest and fails
 * when the harness has moved past the verified list.
 *
 * A vendor peer is placed here too, because a vendor is resolved by the
 * consumer's tree rather than by this repository: see {@link LINE_VENDOR_PINS}.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The scope and package prefix a harness release ships under, cordis excluded. */
const HARNESS_PACKAGE_PREFIX = '@deepseek-ai/dsh'

/** Whether a dependency name is a harness package this matrix has to place. */
function isHarnessPackage(name) {
  return name === HARNESS_PACKAGE_PREFIX || name.startsWith(HARNESS_PACKAGE_PREFIX + '-')
}

/** Orders X.Y.Z[-tag.N] with semver's rule that a prerelease precedes its release. */
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/u.exec(value ?? '')
    if (match === null) throw new Error('unsupported version: ' + String(value))
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] === undefined ? null : [match[4], Number(match[5])],
    }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  if (a.prerelease === null) return b.prerelease === null ? 0 : 1
  if (b.prerelease === null) return -1
  if (a.prerelease[0] !== b.prerelease[0]) return a.prerelease[0] < b.prerelease[0] ? -1 : 1
  return a.prerelease[1] - b.prerelease[1]
}

/** The releases the gates actually ran against, as declared by the manifest. */
export function verifiedReleases(manifest) {
  return Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {})
}

/**
 * The model-adapter vendor each verified release ships, keyed by that release.
 *
 * This plugin builds a provider out of the vendor and hands it to the host's own
 * adapter seam, so both sides have to be the same copy: a peer that excludes the
 * vendor a served line pins does not fail the install, it resolves a private
 * older copy under this plugin, and the objects that copy builds then meet the
 * host's newer request vocabulary. On `0.2.0-rc.2` the private `0.85.1`
 * estimator read the host's system message as a list of content blocks and
 * failed the first turn. Read the versions with
 * `npm view @deepseek-ai/dsh-llm-pi-ai@<release> dependencies` when a line is
 * added; the entries below are what those ranges resolved to in a verified
 * clone.
 */
const LINE_VENDOR_PINS = {
  '0.1.5-rc.2': { '@earendil-works/pi-ai': '0.85.1' },
  '0.1.5-rc.3': { '@earendil-works/pi-ai': '0.85.1' },
  '0.1.7-rc.2': { '@earendil-works/pi-ai': '0.85.1' },
  '0.2.0-rc.2': { '@earendil-works/pi-ai': '0.87.1' },
}

/** Whether one alternative of a declared range is a shape this guard verifies. */
function isVerifiableAlternative(alternative) {
  return alternative === '*'
    || /^\^\d+\.\d+\.\d+$/u.test(alternative)
    || /^\d+\.\d+\.\d+$/u.test(alternative)
}

/** Whether every alternative of a declared range is a shape this guard verifies. */
function isVerifiableRange(declared) {
  const alternatives = String(declared).split('||').map(part => part.trim())
  return alternatives.length > 0 && alternatives.every(isVerifiableAlternative)
}

/**
 * Whether a declared range admits one version. Only the shapes
 * {@link isVerifiableRange} accepts reach here, so an unreadable range is
 * reported instead of being read as an admission.
 *
 * @param declared - the range as the manifest writes it.
 * @param version - one exact X.Y.Z the served line ships.
 * @returns whether some alternative admits that version.
 */
export function admitsVersion(declared, version) {
  return String(declared).split('||').some(part => {
    const alternative = part.trim()
    if (alternative === '*') return true
    const caret = /^\^(\d+\.\d+\.\d+)$/u.exec(alternative)
    if (caret !== null) {
      // Caret on 0.x keeps the minor: ^0.85.1 admits 0.85.x and never 0.87.
      const [major, minor] = caret[1].split('.').map(Number)
      return version.startsWith(major + '.' + minor + '.')
    }
    return alternative === version
  })
}

/**
 * Every inconsistency between the declared range, the verified releases, and
 * the harness packages this manifest mounts, peers on, or compiles against.
 *
 * A package either accepts the whole compatible range or names one verified
 * release. The range is what a peer resolves; a mounted row that serves a newer
 * line cannot use it, because npm admits a prerelease only through a comparator
 * naming that exact X.Y.Z tuple: ">=0.1.5-rc.1 <0.2.0" reaches 0.1.5-rc.3 and
 * never 0.1.7-rc.2, so those rows name the release this tree was verified
 * against, the way the harness's own bundles pin.
 *
 * @param manifest - the parsed package.json of this repository.
 * @returns one message per inconsistency; empty when the matrix holds.
 */
export function checkMatrix(manifest) {
  const problems = []
  const compatibility = manifest.dsh?.compatibility?.dsh
  const releases = verifiedReleases(manifest)
  const range = /^>=(\S+) <(\S+)$/u.exec(compatibility ?? '')
  if (range === null) {
    problems.push('dsh.compatibility.dsh must declare a ">=lower <upper" range, found ' + String(compatibility))
  }
  if (releases.length === 0) {
    problems.push('dsh.compatibility.dshReleases must name at least one verified release')
  }
  if (range !== null) {
    for (const release of releases) {
      if (compareVersions(release, range[1]) < 0 || compareVersions(release, range[2]) >= 0) {
        problems.push('verified release ' + release + ' lies outside the compatible range ' + String(compatibility))
      }
    }
  }

  /** One declared placing, checked wherever a harness package may be named. */
  const checkPlacing = (name, declared, location) => {
    if (declared === compatibility || releases.includes(declared)) return
    problems.push(location + ' ' + name + ' declares ' + String(declared)
      + ', which is neither the compatible range ' + String(compatibility)
      + ' nor one of the verified releases ' + releases.join(', '))
  }
  for (const [name, declared] of Object.entries(manifest.dependencies ?? {})) {
    if (isHarnessPackage(name)) checkPlacing(name, declared, 'mounted package')
    // An aliased install carries the release of the line no range can reach.
    if (!String(declared).startsWith('npm:')) continue
    const aliased = /^npm:(.+)@([^@]+)$/u.exec(String(declared))
    if (aliased === null || !releases.includes(aliased[2])) {
      problems.push('aliased dependency ' + name + ' declares ' + String(declared) + ', whose version is not a verified release')
    }
  }
  // A peer is resolved against the consumer's own tree, so a peer range is the
  // one place the range cannot do its job: npm admits a prerelease only through
  // a comparator naming its own X.Y.Z tuple, so ">=0.1.5-rc.1 <0.2.0" does not
  // accept a 0.1.7 prerelease the profile already has and resolves a second
  // framework copy beside it. The peers stay open, and the range lives in
  // dsh.compatibility.dsh for a reader (see RELEASE.md#harness-matrix).
  for (const [name, declared] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!isHarnessPackage(name)) continue
    if (declared === '*' || declared === compatibility || releases.includes(declared)) continue
    problems.push('peer dependency ' + name + ' declares ' + String(declared)
      + ', which is neither open (*), the compatible range ' + String(compatibility)
      + ', nor one of the verified releases ' + releases.join(', '))
  }

  // A vendor version is resolved by the consumer's tree, not by the range this
  // manifest declares, so the peer is the only place that can keep one copy:
  // narrowing it is what let a private older copy meet the host's newer
  // contexts (see LINE_VENDOR_PINS).
  for (const release of releases) {
    const pins = LINE_VENDOR_PINS[release]
    if (pins === undefined) {
      problems.push('verified release ' + release + ' has no recorded vendor pin; read its @deepseek-ai/dsh-llm-pi-ai dependencies and record them')
      continue
    }
    for (const [name, version] of Object.entries(pins)) {
      const declared = manifest.peerDependencies?.[name]
      if (declared === undefined) {
        problems.push('peer dependency ' + name + ' is missing, so the ' + version + ' that line ' + release + ' ships resolves a second copy beside the host\'s')
      } else if (!isVerifiableRange(declared)) {
        problems.push('peer dependency ' + name + ' declares ' + String(declared) + ', which this guard cannot verify against the ' + version + ' line ' + release + ' ships')
      } else if (!admitsVersion(declared, version)) {
        problems.push('peer dependency ' + name + ' declares ' + String(declared) + ', which does not admit ' + version + ', the vendor line ' + release + ' ships')
      }
    }
  }

  const compiled = Object.entries(manifest.devDependencies ?? {})
    .filter(([name]) => isHarnessPackage(name))
  if (compiled.length === 0) problems.push('the manifest compiles against no harness package')
  const compiledVersions = new Set(compiled.map(([, declared]) => declared))
  if (compiledVersions.size !== 1) {
    problems.push('the harness devDependencies name ' + compiledVersions.size + ' versions, not one')
  }
  for (const version of compiledVersions) {
    if (!releases.includes(version)) {
      problems.push('the harness devDependencies compile against ' + version + ', which is not a verified release')
    }
  }
  return problems
}

/** The registry's own answer to which release a bare install would resolve. */
async function checkRegistry(releases, problems) {
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh')
  if (!response.ok) {
    problems.push('the registry read failed with HTTP ' + response.status)
    return
  }
  const metadata = await response.json()
  const latest = metadata['dist-tags']?.latest
  if (typeof latest !== 'string') {
    problems.push('the registry answered no latest dist-tag')
  } else if (!releases.includes(latest)) {
    problems.push('the harness publishes ' + latest + ' as latest, which is not a verified release')
    console.error('harness-matrix: add it to dsh.compatibility.dshReleases, raise the harness devDependencies and every mounted harness package, then dogfood; RELEASE.md owns the bump')
  } else {
    console.log('harness-matrix: registry latest ' + latest + ' is verified')
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const problems = checkMatrix(manifest)
  if (process.argv.includes('--check-registry')) await checkRegistry(verifiedReleases(manifest), problems)
  if (problems.length > 0) {
    console.error('harness-matrix: the matrix is inconsistent')
    for (const problem of problems) console.error('  - ' + problem)
    process.exit(1)
  }
  const compiled = Object.entries(manifest.devDependencies ?? {})
    .filter(([name]) => isHarnessPackage(name))
    .map(([, declared]) => declared)
  console.log('harness-matrix: ok (' + verifiedReleases(manifest).length + ' verified, compiled '
    + [...new Set(compiled)].join(', ') + ', range ' + String(manifest.dsh?.compatibility?.dsh) + ')')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
