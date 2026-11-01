import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@sagmans/dsh-provider-extra'
const CLI_PACKAGE = '@deepseek-ai/dsh'
const ROOT = fileURLToPath(new URL('../', import.meta.url))
// The profile mechanics under test belong to the CLI that ships to users, so
// the suite drives the registry build rather than a source checkout; the bin
// path comes from that package's own manifest instead of a guessed layout.
const CLI_MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'node_modules', CLI_PACKAGE, 'package.json'), 'utf8'),
)
const CLI = join(ROOT, 'node_modules', CLI_PACKAGE, CLI_MANIFEST.bin.dsh)
const PROFILES = ['web', 'tui']
const TIMEOUT_MS = 30_000
const PLUGIN_ROW = /^\s*-?\s*name:\s*['"]?@sagmans\/dsh-provider-extra['"]?\s*$/gm
const OVERRIDE = '- id: dsh-provider-extra\n  config:\n    routeId: bundle-test-route\n'

for (const profile of PROFILES) {
  test(`CLI add/remove owns activation in the ${profile} profile`, () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-extra-bundle-'))
    const run = (...args) => {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        cwd: ROOT,
        env: {
          ...process.env,
          DSH_HOME: home,
          DSH_TELEMETRY_DISABLED: '1',
          npm_config_offline: 'true',
          npm_config_ignore_scripts: 'true',
        },
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
      })
      assert.equal(result.status, 0, result.stderr || result.error?.message)
      return result.stdout
    }
    const manifest = () =>
      JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
    try {
      run('plugin', '--profile', profile, 'add', '--offline', '--ignore-scripts', `link:${ROOT}`)
      assert.ok(manifest().dsh.profile.bundles.includes(PACKAGE_NAME))
      assert.equal([...run('--profile', profile, '--dump-config').matchAll(PLUGIN_ROW)].length, 1)

      writeFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), OVERRIDE)
      assert.match(run('--profile', profile, '--dump-config'), /routeId: bundle-test-route/)
      run('plugin', '--profile', profile, 'add', '--offline', '--ignore-scripts', `link:${ROOT}`)
      assert.equal(manifest().dsh.profile.bundles.filter((name) => name === PACKAGE_NAME).length, 1)

      run('plugin', '--profile', profile, 'remove', PACKAGE_NAME)
      assert.ok(!manifest().dsh.profile.bundles.includes(PACKAGE_NAME))
      assert.equal([...run('--profile', profile, '--dump-config').matchAll(PLUGIN_ROW)].length, 0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}
