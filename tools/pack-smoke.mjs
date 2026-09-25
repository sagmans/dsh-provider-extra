#!/usr/bin/env node
/**
 * Package smoke test.
 *
 * A registry install is the only install most users ever see, so the artefact
 * must be proven shippable before a tag can reach the publish job: every entry
 * point a loader resolves must be inside the tarball, the packed manifest must
 * point at files that shipped, and nothing that belongs to development may
 * travel with them. The tarball's own manifest is inspected rather than the
 * checkout's, because a local-path spec that only exists before packing would
 * still break the install users get.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { checkSelections } from './catalog-artifact-policy.mjs'
import { writeFileSync } from 'node:fs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Entries a profile loader or a reader needs in the tarball. */
const REQUIRED = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/docs/catalog.md',
  'package/docs/catalog-v1.example.json',
  'package/LICENSE',
  'package/dist/index.js',
  'package/dist/codex.js',
  'package/dist/login-cli.js',
  'package/dist/opencode-go.js',
]

/** Entries that must never ship: development inputs and local state. */
const FORBIDDEN = [
  /^package\/(src|tests|tools|scripts|node_modules|\.harness)\//u,
  /^package\/(tsconfig[^/]*\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u,
  /^package\/\.github\//u,
]

/** The bundle row this plugin owns, exactly as a profile loader resolves it. */
const PATCH_ROW = "name: '@sagmans/dsh-provider-extra'"

/** The bin that lets a registry install complete the attended Codex sign-in. */
const BIN_NAME = 'dsh-provider-extra-login'

/** Dependency protocols that cannot be resolved from a registry tarball. */
const LOCAL_PROTOCOLS = ['link:', 'workspace:', 'file:']
const SHAPE_EXAMPLE = 'package/docs/catalog-v1.example.json'

function walk(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walk(path))
    else found.push(path)
  }
  return found
}

const problems = []
const out = mkdtempSync(join(tmpdir(), 'dsh-provider-extra-pack-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: ROOT, stdio: 'inherit' })
  const tarball = readdirSync(out).find(name => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error('pnpm pack produced no tarball')
  const archive = join(out, tarball)
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(entry => entry !== '')
  const read = (entry) => execFileSync('tar', ['-xOzf', archive, entry], { encoding: 'utf8' })

  for (const entry of REQUIRED) {
    if (!entries.includes(entry)) problems.push('missing from the tarball: ' + entry)
  }
  for (const entry of entries) {
    if (FORBIDDEN.some(pattern => pattern.test(entry))) problems.push('should not ship: ' + entry)
  }

  const packed = JSON.parse(read('package/package.json'))
  if (packed.private === true) problems.push('the packed manifest is private, so npm would refuse it')
  const shipped = (target) => typeof target === 'string' && entries.includes('package/' + target.replace(/^\.\//u, ''))
  const declared = packed.dsh?.bundle?.patch
  if (!shipped(declared)) problems.push('the manifest does not point at a bundle patch that ships')
  const declaredTargets = [
    ['main', packed.main],
    ...Object.entries(packed.exports ?? {}).map(([key, value]) => ['exports["' + key + '"]', value]),
  ]
  for (const [label, target] of declaredTargets) {
    if (!shipped(target)) problems.push(label + ' points at ' + String(target) + ', which is not in the tarball')
  }

  const binTarget = packed.bin?.[BIN_NAME]
  if (!shipped(binTarget)) problems.push('bin.' + BIN_NAME + ' points at ' + String(binTarget) + ', which is not in the tarball')
  else if (!read('package/' + binTarget.replace(/^\.\//u, '')).startsWith('#!')) {
    problems.push('bin.' + BIN_NAME + ' has no shebang, so an install cannot execute it')
  }

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(packed[field] ?? {})) {
      if (typeof spec === 'string' && LOCAL_PROTOCOLS.some(protocol => spec.startsWith(protocol))) {
        problems.push(field + '.' + name + ' uses ' + spec.split(':')[0] + ':, which a registry install cannot resolve')
      }
    }
  }

  const patch = read('package/cordis.patch.yml')
  if (!patch.includes(PATCH_ROW)) problems.push('the bundle patch no longer names ' + PATCH_ROW)
  const local = createRequire(import.meta.url)
  const host = createRequire(local.resolve('@deepseek-ai/dsh/package.json'))
  const { loadOverlayPatches } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-app-boot')).href)
  const parsedPatch = text => {
    const file = join(out, 'example.patch.yml')
    writeFileSync(file, text)
    return loadOverlayPatches('pack-smoke', file)
  }
  const defaults = parsedPatch(patch)
  if (defaults.some(row => row.config?.catalog || row.insert?.some(child => child.config?.catalog))) problems.push('bundle patch must not activate a catalog')
  for (const entry of entries) {
    if (entry.endsWith('.json') && entry !== 'package/package.json') {
      if (entry !== SHAPE_EXAMPLE) problems.push('unexpected packaged catalog/data file: ' + entry)
      checkSelections(JSON.parse(read(entry)), entry, problems)
    }
    if (entry.endsWith('.yml') || entry.endsWith('.yaml')) checkSelections(parsedPatch(read(entry)), entry, problems)
    if (entry.endsWith('.md')) {
      for (const match of read(entry).matchAll(/```(yaml|yml|json)\n([\s\S]*?)```/gu)) {
        checkSelections(match[1] === 'json' ? JSON.parse(match[2]) : parsedPatch(match[2]), entry, problems)
      }
    }
  }

  const modules = walk(join(ROOT, 'dist')).filter(file => file.endsWith('.js'))
  for (const module of modules) execFileSync(process.execPath, ['--check', module], { stdio: 'inherit' })

  console.log('\npacked ' + entries.length + ' entries, ' + modules.length + ' modules parse')
  console.log('tarball: ' + archive)
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error))
} finally {
  rmSync(out, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error('\npack-smoke: the artefact is not shippable')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('pack-smoke: ok')
