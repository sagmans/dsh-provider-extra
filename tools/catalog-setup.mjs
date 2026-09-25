#!/usr/bin/env node
/** Development-only setup preserves the source home and lets the host parse its own patch format. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstatSync, readFileSync, realpathSync, writeFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const PACKAGE = '@sagmans/dsh-provider-extra'
const HOST_PACKAGE = '@deepseek-ai/dsh'
const CORE = '@deepseek-ai/dsh-llm'
const PATCH = 'cordis.patch.yml'
const MARKER = '.dsh-dogfood'
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_BITS = 0o077
const REQUIRED = ['--helper', '--source-home', '--home', '--profile', '--catalog']
const ALLOW_ROW = '--allow-row'
const OWNERS = new Set([
  '@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-llm-openai',
  '@deepseek-ai/dsh-llm-anthropic', '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-agent-default-model',
])
const SUPPORT = new Set([CORE, PACKAGE, '@deepseek-ai/dsh-llm-retry', '@deepseek-ai/dsh-deepseek-llm-api-extensions'])
const OPAQUE = new Set(['@deepseek-ai/cordis-plugin-group', '@deepseek-ai/cordis-plugin-include'])
const PROVIDER_LIKE = /(?:^|[-/])(?:llm|provider)(?:[-/]|$)|agent-default-model/
const USAGE = 'node tools/catalog-setup.mjs --helper /path/run-plugin-from-worktree.sh --source-home /path/source --home /path/new-clone --profile NAME --catalog /private/config.json [--dsh /path/dsh/lib/bin.js] [--allow-row ID]...'
/** Row provenance is not visible here, so an operator must assert a provider-like row that registers nothing. */
const ALLOW_ROW_HINT = '; pass ' + ALLOW_ROW + ' ID only if that row registers no model provider and no default owner'

/** Explicit inputs prevent an unattended command from defaulting to the live home. */
function argumentsFrom(argv) {
  if (argv.length === 1 && argv[0] === '--help') return undefined
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (![...REQUIRED, '--dsh', ALLOW_ROW].includes(flag) || !value || value.startsWith('--')) throw new Error(USAGE)
    if (flag === ALLOW_ROW) {
      values[flag] = [...values[flag] ?? [], value]
      continue
    }
    if (values[flag] !== undefined) throw new Error(USAGE)
    values[flag] = value
  }
  if (REQUIRED.some(flag => !values[flag])) throw new Error(USAGE)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(values['--profile'])) throw new Error('invalid profile name')
  return values
}

/** Package metadata pins composition and the printed launch to the same host. */
function hostFor(binary) {
  const local = createRequire(import.meta.url)
  let manifestPath = local.resolve(HOST_PACKAGE + '/package.json')
  if (binary !== undefined) {
    const executable = realpathSync(binary)
    let directory = dirname(executable)
    for (;;) {
      const candidate = join(directory, 'package.json')
      if (lstatSync(candidate, { throwIfNoEntry: false })?.isFile()) {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
        if (manifest.name === HOST_PACKAGE && manifest.bin?.dsh && realpathSync(join(directory, manifest.bin.dsh)) === executable) {
          manifestPath = candidate
          break
        }
      }
      const parent = dirname(directory)
      if (parent === directory) throw new Error('--dsh must name the actual JavaScript bin from a dsh package, not a shell wrapper')
      directory = parent
    }
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return { manifestPath, binary: realpathSync(join(dirname(manifestPath), manifest.bin.dsh)), require: createRequire(manifestPath) }
}

/** Symlink and hardlink refusal protects the original even when a clone helper is misconfigured. */
function privateFile(file, optional = false) {
  const info = lstatSync(file, { throwIfNoEntry: false })
  if (!info && optional) return
  if (!info?.isFile() || info.nlink !== 1 || info.uid !== process.getuid()) throw new Error('unsafe clone file: ' + file)
}

function checkClone(home, source, profile) {
  for (const directory of [home, join(home, 'profiles'), join(home, 'profiles', profile)]) {
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.uid !== process.getuid()) throw new Error('unsafe clone directory: ' + directory)
  }
  if ((lstatSync(home).mode & PRIVATE_BITS) !== 0) throw new Error('clone home must be private')
  const marker = join(home, MARKER)
  privateFile(marker)
  const expected = { home, source, target: ROOT, profile }
  const actual = Object.fromEntries(readFileSync(marker, 'utf8').trim().split('\n').map(line => {
    const at = line.indexOf('=')
    return [line.slice(0, at), line.slice(at + 1)]
  }))
  assert.deepEqual(actual, expected, 'clone marker does not match setup inputs')
}

/** Static checks deliberately refuse unknown provider-like rows rather than claiming runtime provenance. */
function inspect(rows, allowed = new Set()) {
  const permitted = []
  const ids = new Set()
  for (const row of rows) {
    if (typeof row.id !== 'string' || ids.has(row.id)) throw new Error('profile rows need unique explicit IDs')
    ids.add(row.id)
    if (row.disabled) continue
    if (OPAQUE.has(row.name)) throw new Error('nested or included profile rows require manual clone setup')
    if (!OWNERS.has(row.name) && !SUPPORT.has(row.name) && (PROVIDER_LIKE.test(row.id) || PROVIDER_LIKE.test(row.name ?? ''))) {
      if (!allowed.has(row.id)) throw new Error('unrecognized provider-like row: ' + row.id + ' (' + row.name + ')' + ALLOW_ROW_HINT)
      permitted.push(row.id)
    }
  }
  const active = rows.filter(row => !row.disabled)
  if (active.filter(row => row.name === CORE).length !== 1) throw new Error('setup requires one active core llm row')
  if (active.filter(row => row.name === PACKAGE).length !== 1) throw new Error('setup requires one active provider-extra row')
  return { active, permitted }
}

/** A tiny isolated runtime verifies catalog APIs without mounting credentials, apps, or provider requests. */
async function verifyCatalog(host, pluginFile, config) {
  const { Context } = await import(pathToFileURL(host.require.resolve('@deepseek-ai/cordis')).href)
  const { default: LlmRuntime } = await import(pathToFileURL(host.require.resolve(CORE)).href)
  const plugin = await import(pathToFileURL(pluginFile).href)
  const snapshot = plugin.compileCatalog(config.catalog)
  if (!snapshot) throw new Error('catalog input must explicitly contain catalog')
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, config)
    const providers = config.catalog.providers
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), providers.map(provider => provider.id))
    assert.deepEqual(ctx.llm.listConfigurableProviders(), [])
    let count = 0
    for (const provider of providers) {
      assert.deepEqual((await ctx.llm.listModels(provider.id)).map(model => model.id), provider.models.map(model => model.id))
      count += provider.models.length
    }
    if (snapshot.selection === null) assert.throws(() => ctx.get('agentDefaultModel').currentSelection(), { code: 'NO_DEFAULT_MODEL' })
    else assert.deepEqual(ctx.get('agentDefaultModel').currentSelection(), snapshot.selection)
    return count
  } finally {
    await mounted?.dispose()
    await runtime.dispose()
  }
}

/** The original prefix survives byte-for-byte; the host rejects unsupported YAML rather than a new writer rewriting it. */
async function configure(home, profile, host, input, allowed) {
  const boot = await import(pathToFileURL(host.require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const profileDir = join(home, 'profiles', profile)
  const patchPath = join(profileDir, PATCH)
  const homePatch = join(home, PATCH)
  privateFile(join(profileDir, 'package.json'))
  privateFile(patchPath, true)
  privateFile(homePatch, true)
  const loaded = boot.loadProfileDirectory('catalog-setup', profileDir, host.manifestPath)
  const providerLayer = loaded.layers.find(layer => layer.packageName === PACKAGE)
  if (!providerLayer || realpathSync(providerLayer.packageDir) !== ROOT) throw new Error('resolved provider bundle is not this checkout')
  const profileRequire = createRequire(join(profileDir, 'package.json'))
  const pluginFile = profileRequire.resolve(PACKAGE)
  if (realpathSync(pluginFile) !== realpathSync(join(ROOT, 'dist/index.js'))) throw new Error('resolved provider module is not this build')
  const bundleLayers = loaded.layers.map(layer => layer.patches)
  const homePatches = boot.loadOptionalPatches('catalog-setup', homePatch) ?? []
  const strict = message => { throw new Error('profile composition refused: ' + message) }
  const baseline = boot.composeEntries([...bundleLayers, loaded.patches, homePatches], strict)
  const { active } = inspect(baseline, allowed)
  const owner = active.find(row => row.name === PACKAGE)
  const disabled = active.filter(row => OWNERS.has(row.name))
  const additions = [...disabled.map(row => ({ id: row.id, disabled: true })), { id: owner.id, config: { catalog: input.catalog } }]
  const expected = boot.composeEntries([...bundleLayers, loaded.patches, homePatches, additions], strict)
  const original = lstatSync(patchPath, { throwIfNoEntry: false }) ? readFileSync(patchPath) : Buffer.alloc(0)
  const suffix = '\n' + additions.map(row => '- ' + JSON.stringify(row)).join('\n') + '\n'
  const candidate = Buffer.concat([original, Buffer.from(suffix)])
  const scratch = mkdtempSync(join(profileDir, '.catalog-setup-'))
  const file = join(scratch, PATCH)
  try {
    writeFileSync(file, candidate, { mode: PRIVATE_FILE_MODE, flag: 'wx' })
    let patches
    try { patches = boot.loadOverlayPatches('catalog-setup', file) } catch {
      throw new Error('profile patch must accept an append-only block sequence; edit only a fresh clone manually')
    }
    const composed = boot.composeEntries([...bundleLayers, patches, homePatches], strict)
    if (!isSame(composed, expected)) throw new Error('home overrides conflict with catalog setup; edit only a fresh clone manually')
    const { active: after, permitted } = inspect(composed, allowed)
    if (after.some(row => OWNERS.has(row.name))) throw new Error('known provider/default owner remains active')
    const configured = after.find(row => row.name === PACKAGE)
    assert.deepEqual(configured.config.catalog, input.catalog)
    const count = await verifyCatalog(host, pluginFile, configured.config)
    if (lstatSync(patchPath, { throwIfNoEntry: false })) {
      privateFile(patchPath)
      assert.deepEqual(readFileSync(patchPath), original, 'profile patch changed during setup')
    }
    renameSync(file, patchPath)
    return { count, permitted }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

function isSame(left, right) {
  try { assert.deepEqual(left, right); return true } catch { return false }
}

/** Shell quoting keeps the printed operator command safe without launching it. */
function quote(value) { return "'" + value.replaceAll("'", "'\\''") + "'" }

async function main(argv) {
  const options = argumentsFrom(argv)
  if (!options) { console.log(USAGE); return }
  const source = realpathSync(options['--source-home'])
  const requested = resolve(options['--home'])
  if (lstatSync(requested, { throwIfNoEntry: false })) throw new Error('setup requires a fresh nonexistent home')
  const home = join(realpathSync(dirname(requested)), basename(requested))
  if (home === source || home.startsWith(source + sep) || source.startsWith(home + sep)) throw new Error('source and clone homes must not overlap')
  const profile = options['--profile']
  const helper = realpathSync(options['--helper'])
  const host = hostFor(options['--dsh'])
  const input = JSON.parse(readFileSync(options['--catalog'], 'utf8'))
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'catalog') || Object.keys(input).some(key => key !== 'catalog')) {
    throw new Error('catalog input must be one JSON object containing only catalog')
  }
  if (!lstatSync(join(source, 'profiles', profile, 'package.json'), { throwIfNoEntry: false })?.isFile()) throw new Error('source profile must already exist; setup never installs a profile')
  const env = { ...process.env, DSH_HOME: home, DSH_DOGFOOD_DEFAULT_REPO: ROOT, DSH_DOGFOOD_REQUIRE_LISTED: '0' }
  execFileSync('bash', [helper, '--source-home', source, '--home', home, '--profile', profile, '--dsh', host.binary, '--no-launch', ROOT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  checkClone(home, source, profile)
  process.env.DSH_HOME = home
  const { count, permitted } = await configure(home, profile, host, input, new Set(options[ALLOW_ROW] ?? []))
  console.log('composition-verified: ' + count + ' selected pairs; isolated catalog listing/default checks passed.')
  if (permitted.length > 0) console.log('asserted non-provider rows: ' + permitted.join(', '))
  console.log('Profile not booted. CATALOG_OWNER_COLLISION remains authoritative at boot; no authentication or model requests ran.')
  console.log('Run: env DSH_HOME=' + quote(home) + ' ' + quote(host.binary) + ' --profile ' + quote(profile))
}

try { await main(process.argv.slice(2)) } catch (error) {
  console.error('catalog-setup: ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
}
