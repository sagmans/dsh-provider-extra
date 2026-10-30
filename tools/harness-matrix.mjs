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
 * The range is read twice, because two readers apply it: the dsh plugin gate
 * (`evaluatePluginCompatibility` in `@deepseek-ai/dsh-app-boot`) admits
 * prereleases anywhere inside it, while npm's strict peer resolution admits a
 * prerelease only through a comparator naming its own `X.Y.Z` tuple. A
 * verified release has to pass both, and the upper bound has to refuse the
 * next line's prereleases under the first.
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

/** X.Y.Z with optional dot-separated prerelease identifiers, as semver spells them. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/** One comparator: an operator this guard reads and the version it bounds. */
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?(\S+)$/u

/** The one spelling a compatible-range alternative takes: an inclusive lower and an exclusive upper bound. */
const RANGE_ALTERNATIVE_PATTERN = /^>=\S+ <\S+$/u

/**
 * The prerelease an upper bound carries so it also refuses the bound's own
 * prereleases: `<0.3.0` admits `0.3.0-rc.1` wherever prereleases are read,
 * `<0.3.0-0` does not, because `0` is the lowest prerelease semver orders.
 */
const LOWEST_PRERELEASE = '0'

/** Whether a dependency name is a harness package this matrix has to place. */
function isHarnessPackage(name) {
  return name === HARNESS_PACKAGE_PREFIX || name.startsWith(HARNESS_PACKAGE_PREFIX + '-')
}

/**
 * One version split into its release tuple and prerelease identifiers.
 * @throws Error when the value is not a plain semver version.
 */
function parseVersion(value) {
  const match = VERSION_PATTERN.exec(value ?? '')
  if (match === null) throw new Error('unsupported version: ' + String(value))
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.').map(part => /^\d+$/u.test(part) ? Number(part) : part),
  }
}

/** Orders two prerelease identifiers: numeric before alphanumeric, each by its own kind. */
function compareIdentifiers(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'number') return -1
  if (typeof right === 'number') return 1
  return left === right ? 0 : left < right ? -1 : 1
}

/** Orders two parsed versions with semver's rule that a prerelease precedes its release. */
function compareParsed(a, b) {
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  if (a.prerelease.length === 0) return b.prerelease.length === 0 ? 0 : 1
  if (b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    // A shorter identifier list that matches so far is the earlier prerelease.
    if (a.prerelease[index] === undefined) return -1
    if (b.prerelease[index] === undefined) return 1
    const order = compareIdentifiers(a.prerelease[index], b.prerelease[index])
    if (order !== 0) return order
  }
  return 0
}

/** Orders X.Y.Z[-pre] with semver's rule that a prerelease precedes its release. */
export function compareVersions(left, right) {
  return compareParsed(parseVersion(left), parseVersion(right))
}

/**
 * The comparators of a caret, in node-semver's own expansion: the upper bound
 * carries the lowest prerelease, and on 0.x the caret keeps the minor (or, on
 * 0.0.x, the patch) — `^0.85.1` admits 0.85.x and never 0.87.
 */
function caretComparators(version) {
  const [major, minor, patch] = version.numbers
  const upper = major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1]
  return [{ operator: '>=', version }, { operator: '<', version: { numbers: upper, prerelease: [LOWEST_PRERELEASE] } }]
}

/**
 * A declared range as comparator sets, one per `||` alternative.
 * `*` is an empty set; a token this guard cannot read makes the whole range
 * unreadable, so a misread range is reported instead of read as an admission.
 * @param declared - the range as the manifest writes it.
 * @returns the comparator sets, or undefined when any token is unreadable.
 */
export function parseRange(declared) {
  const sets = []
  for (const part of String(declared).split('||')) {
    const alternative = part.trim()
    if (alternative === '') return undefined
    if (alternative === '*') {
      sets.push([])
      continue
    }
    const set = []
    for (const token of alternative.split(/\s+/u)) {
      try {
        if (token.startsWith('^')) {
          set.push(...caretComparators(parseVersion(token.slice(1))))
          continue
        }
        const match = COMPARATOR_PATTERN.exec(token)
        if (match === null) return undefined
        set.push({ operator: match[1] ?? '=', version: parseVersion(match[2]) })
      } catch {
        return undefined
      }
    }
    sets.push(set)
  }
  return sets
}

/** Whether one comparator admits a parsed version, ignoring prerelease policy. */
function comparatorAdmits(comparator, version) {
  const order = compareParsed(version, comparator.version)
  switch (comparator.operator) {
    case '>=': return order >= 0
    case '>': return order > 0
    case '<=': return order <= 0
    case '<': return order < 0
    default: return order === 0
  }
}

/** Whether a comparator names a prerelease of the version's own X.Y.Z tuple. */
function namesPrereleaseOf(comparator, version) {
  return comparator.version.prerelease.length > 0
    && comparator.version.numbers.every((number, index) => number === version.numbers[index])
}

/**
 * Whether a declared range admits one version, the way node-semver's
 * `satisfies` answers it.
 *
 * @param declared - the range as the manifest writes it.
 * @param version - one exact version.
 * @param options.includePrerelease - read prereleases anywhere inside the
 *   range, as the dsh plugin gate does; otherwise only through a comparator
 *   naming the version's own tuple, as npm's peer resolution does.
 * @returns whether some alternative admits the version; false for an unreadable range.
 */
export function satisfiesRange(declared, version, { includePrerelease = false } = {}) {
  const sets = parseRange(declared)
  if (sets === undefined) return false
  const parsed = parseVersion(version)
  return sets.some(set => set.every(comparator => comparatorAdmits(comparator, parsed))
    && (parsed.prerelease.length === 0 || includePrerelease
      || set.some(comparator => namesPrereleaseOf(comparator, parsed))))
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
  '0.2.1-rc.2': { '@earendil-works/pi-ai': '1.3.0' },
  '0.2.1-rc.3': { '@earendil-works/pi-ai': '1.4.0' },
}

/**
 * Whether one alternative of a vendor range is one this guard can verify:
 * open, or bounded above. An alternative with no upper bound admits vendor
 * minors nobody verified, and a vendor minor can drop catalog ids this plugin
 * templates from (1.3.0 dropped `deepseek-v4-flash`).
 */
function isBoundedAlternative(set) {
  return set.length === 0 || set.some(comparator => comparator.operator === '<' || comparator.operator === '<='
    || comparator.operator === '=')
}

/** Whether every alternative of a declared vendor range is a shape this guard verifies. */
function isVerifiableRange(declared) {
  const sets = parseRange(declared)
  return sets !== undefined && sets.length > 0 && sets.every(isBoundedAlternative)
}

/**
 * Whether a declared vendor range admits one released vendor version. Only the
 * shapes {@link isVerifiableRange} accepts reach here, so an unreadable range is
 * reported instead of being read as an admission.
 *
 * @param declared - the range as the manifest writes it.
 * @param version - one exact X.Y.Z the served line ships.
 * @returns whether some alternative admits that version.
 */
export function admitsVersion(declared, version) {
  return satisfiesRange(declared, version)
}

/**
 * The problems of the compatible range itself: every alternative must be a
 * bounded `>=lower <upper-0` pair, so both readers agree on where it ends.
 */
function checkRangeShape(compatibility) {
  // The spelled form is required, not just its meaning: a caret or tilde reads
  // the same to semver but hides where a line ends from the reader.
  const spelled = String(compatibility ?? '').split('||').every(part => RANGE_ALTERNATIVE_PATTERN.test(part.trim()))
  const sets = spelled ? parseRange(compatibility) : undefined
  const bounded = sets !== undefined && sets.length > 0 && sets.every(set => set.length === 2
    && set[0].operator === '>=' && set[1].operator === '<')
  if (!bounded) {
    return ['dsh.compatibility.dsh must declare ">=lower <upper" alternatives joined by "||", found ' + String(compatibility)]
  }
  const open = sets.map(set => set[1].version)
    .filter(upper => upper.prerelease.length !== 1 || upper.prerelease[0] !== Number(LOWEST_PRERELEASE))
  return open.map(upper => 'dsh.compatibility.dsh bounds a line at <' + upper.numbers.join('.')
    + (upper.prerelease.length === 0 ? '' : '-' + upper.prerelease.join('.'))
    + ', which the dsh plugin gate reads as admitting that line\'s prereleases; bound it at <'
    + upper.numbers.join('.') + '-' + LOWEST_PRERELEASE)
}

/**
 * Every inconsistency between the declared range, the verified releases, and
 * the harness packages this manifest mounts, peers on, or compiles against.
 *
 * A package either accepts the whole compatible range or names one verified
 * release. The range is what a peer resolves and what the dsh plugin gate
 * reads before it mounts this plugin, so a harness peer carries it rather than
 * `*`: an open peer admits every host, including lines whose vendor this
 * plugin cannot serve.
 *
 * @param manifest - the parsed package.json of this repository.
 * @returns one message per inconsistency; empty when the matrix holds.
 */
export function checkMatrix(manifest) {
  const problems = []
  const compatibility = manifest.dsh?.compatibility?.dsh
  const releases = verifiedReleases(manifest)
  const rangeProblems = checkRangeShape(compatibility)
  problems.push(...rangeProblems)
  if (releases.length === 0) {
    problems.push('dsh.compatibility.dshReleases must name at least one verified release')
  }
  if (rangeProblems.length === 0) {
    for (const release of releases) {
      if (!satisfiesRange(compatibility, release, { includePrerelease: true })) {
        problems.push('verified release ' + release + ' lies outside the compatible range ' + String(compatibility))
      } else if (!satisfiesRange(compatibility, release)) {
        // npm reads the same range for the peers and would refuse the host's
        // own release, resolving a second framework copy beside it.
        problems.push('verified release ' + release + ' is a prerelease npm peer resolution refuses under '
          + String(compatibility) + '; give its X.Y.Z tuple an alternative of its own')
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
  // A peer carries the range, never `*`: the dsh plugin gate reads harness
  // peers before it mounts the plugin, and an open peer lets a host whose
  // vendor line this plugin cannot serve mount it and fail the first turn.
  for (const [name, declared] of Object.entries(manifest.peerDependencies ?? {})) {
    if (isHarnessPackage(name)) checkPlacing(name, declared, 'peer dependency')
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
