/** Clone setup must preserve source bytes and use real host patch semantics. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOOL = join(ROOT, 'tools/catalog-setup.mjs')
const PROFILE = 'test'
const CATALOG = { catalog: { version: 1, providers: [{
  id: 'example-route', name: 'Example route', source: 'openai', auth: { apiKeyRef: 'EXAMPLE_API_KEY' },
  models: [{ id: 'example-model', name: 'Example model', metadata: {
    api: 'openai-responses', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
  } }],
}], default: { provider: 'example-route', model: 'example-model' } } }
const ORIGINAL = '# preserve this comment and newline\n- id: unrelated\n  config:\n    keep: untouched\n'
const ROWS = [
  { id: 'llm', name: '@deepseek-ai/dsh-llm' },
  { id: 'native-custom-id', name: '@deepseek-ai/dsh-llm-deepseek' },
  { id: 'generic-custom-id', name: '@deepseek-ai/dsh-llm-pi-ai' },
  { id: 'default-custom-id', name: '@deepseek-ai/dsh-agent-default-model' },
  { id: 'unrelated', name: 'fixture-unrelated', config: { earlier: true } },
]
// This fixture isolates setup checks; real-helper dogfood separately proves cloning and building.
const HELPER = `#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-home) source="$2"; shift 2 ;;
    --home) home="$2"; shift 2 ;;
    --profile) profile="$2"; shift 2 ;;
    --dsh) shift 2 ;;
    --no-launch) shift ;;
    *) target="$1"; shift ;;
  esac
done
mkdir -m 700 "$home"
cp -R "$source/." "$home/"
printf 'home=%s\\nsource=%s\\ntarget=%s\\nprofile=%s\\n' "$home" "$source" "$target" "$profile" > "$home/.dsh-dogfood"
chmod 600 "$home/.dsh-dogfood"
node --input-type=module - "$home/profiles/$profile" "$target" <<'JS'
import fs from 'node:fs'
import path from 'node:path'
const [dir, target] = process.argv.slice(2)
const file = path.join(dir, 'package.json')
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
manifest.dependencies['@sagmans/dsh-provider-extra'] = 'link:' + target
manifest.dsh.profile.bundles.push('@sagmans/dsh-provider-extra')
fs.mkdirSync(path.join(dir, 'node_modules/@sagmans'), { recursive: true })
fs.symlinkSync(target, path.join(dir, 'node_modules/@sagmans/dsh-provider-extra'))
fs.writeFileSync(file, JSON.stringify(manifest))
JS
`

async function fixture(t, rows = ROWS, patch = ORIGINAL) {
  const dir = await mkdtemp(join(tmpdir(), 'provider-catalog-setup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'source')
  const home = join(dir, 'clone')
  const profile = join(source, 'profiles', PROFILE)
  const bundle = join(profile, 'node_modules/fixture-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['fixture-bundle'] } } }))
  await writeFile(join(profile, 'cordis.patch.yml'), patch)
  const helper = join(dir, 'helper.sh')
  await writeFile(helper, HELPER)
  const catalog = join(dir, 'catalog.json')
  await writeFile(catalog, JSON.stringify(CATALOG))
  return { dir, source, home, helper, profile, patch, catalog }
}

function run(f, extra = []) {
  return spawnSync(process.execPath, [TOOL, '--helper', f.helper, '--source-home', f.source, '--home', f.home, '--profile', PROFILE, '--catalog', f.catalog, ...extra], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSH_HOME: f.source },
  })
}

test('setup preserves bytes, disables confirmed custom IDs, and reports composition only', async t => {
  const f = await fixture(t)
  const sourceManifest = await readFile(join(f.profile, 'package.json'), 'utf8')
  const result = run(f)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /composition-verified/)
  assert.match(result.stdout, /1 selected pairs/)
  assert.doesNotMatch(result.stdout, /ownership verified|authenticated/)
  assert.match(result.stdout, /CATALOG_OWNER_COLLISION/)
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), ORIGINAL)
  assert.equal(await readFile(join(f.profile, 'package.json'), 'utf8'), sourceManifest)
  const patch = await readFile(join(f.home, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.startsWith(ORIGINAL))
  for (const id of ['native-custom-id', 'generic-custom-id', 'default-custom-id']) assert.match(patch, new RegExp('"id":"' + id + '","disabled":true'))
  assert.doesNotMatch(patch, /"id":"llm","disabled"/)
  assert.equal((await stat(join(f.home, 'profiles', PROFILE, 'cordis.patch.yml'))).mode & 0o777, 0o600)
  const repeated = run(f)
  assert.notEqual(repeated.status, 0)
  assert.match(repeated.stderr, /fresh nonexistent home/)
})

for (const [label, rows, patch, error] of [
  ['unknown provider', [...ROWS, { id: 'llm-mystery', name: 'custom-provider' }], ORIGINAL, /unrecognized provider-like row/],
  ['unknown default owner', [...ROWS, { id: 'agent-default-model', name: 'custom-default' }], ORIGINAL, /unrecognized provider-like row/],
  ['flow-array patch', ROWS, '[]\n', /append-only block sequence/],
  ['closed YAML document', ROWS, ORIGINAL + '...\n', /append-only block sequence/],
  ['missing core LLM', ROWS.filter(row => row.id !== 'llm'), ORIGINAL, /one active core llm/],
]) {
  test('setup refuses ' + label + ' without changing the copied patch', async t => {
    const f = await fixture(t, rows, patch)
    const result = run(f)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, error)
    assert.equal(await readFile(join(f.source, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8'), patch)
    assert.equal(await readFile(join(f.home, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8'), patch)
  })
}

// A real home carries rows whose names read like providers but own no adapter; setup cannot see provenance.
const NON_PROVIDER_ROW = { id: 'session-title-llm', name: '@deepseek-ai/dsh-session-title-first-prompt-llm' }

test('setup refuses a provider-like row until the operator asserts it registers nothing', async t => {
  const rows = [...ROWS, NON_PROVIDER_ROW]
  const refused = await fixture(t, rows)
  const refusal = run(refused)
  assert.notEqual(refusal.status, 0)
  assert.match(refusal.stderr, /unrecognized provider-like row: session-title-llm/)
  assert.match(refusal.stderr, /--allow-row/)

  const permitted = await fixture(t, rows)
  const allowed = run(permitted, ['--allow-row', NON_PROVIDER_ROW.id])
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.match(allowed.stdout, /asserted non-provider rows: session-title-llm/)
  assert.match(await readFile(join(permitted.home, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8'), /^# preserve this comment/)
})

test('home overrides cannot silently replace the selected catalog', async t => {
  const f = await fixture(t)
  await writeFile(join(f.source, 'cordis.patch.yml'), JSON.stringify([{ id: 'dsh-provider-extra', config: { catalog: { version: 1, providers: [], default: null } } }]))
  const result = run(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /home overrides/)
  assert.equal(await readFile(join(f.home, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8'), ORIGINAL)
})

test('unrelated home preferences remain untouched', async t => {
  const f = await fixture(t)
  const preferences = '# global unrelated preference\n- id: unrelated\n  config:\n    privacy: true\n'
  await writeFile(join(f.source, 'cordis.patch.yml'), preferences)
  const result = run(f)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(join(f.home, 'cordis.patch.yml'), 'utf8'), preferences)
})

test('unsafe existing or overlapping homes fail before helper execution', async t => {
  const f = await fixture(t)
  await symlink(f.source, f.home)
  const result = run(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /fresh nonexistent home/)
  const overlap = run({ ...f, home: join(f.source, 'nested') })
  assert.notEqual(overlap.status, 0)
  assert.match(overlap.stderr, /must not overlap/)
})

// An explicit external helper keeps TUI independent while allowing real clone/build dogfood.
test('real generic helper builds and relinks only the provider in a credentials-free clone', { skip: !process.env.DSH_DOGFOOD_HELPER }, async t => {
  const f = await fixture(t)
  const result = run({ ...f, helper: process.env.DSH_DOGFOOD_HELPER })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /composition-verified/)
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), ORIGINAL)
})

test('symlinked profile patch cannot write through to another file', async t => {
  const f = await fixture(t)
  const outside = join(f.dir, 'outside.yml')
  await writeFile(outside, ORIGINAL)
  await rm(join(f.profile, 'cordis.patch.yml'))
  await symlink(outside, join(f.profile, 'cordis.patch.yml'))
  const result = run(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unsafe clone file/)
  assert.equal(await readFile(outside, 'utf8'), ORIGINAL)
})

test('invalid catalog never replaces the copied patch or reports success', async t => {
  const f = await fixture(t)
  const invalid = structuredClone(CATALOG)
  invalid.catalog.providers[0].source = 'example-unsupported-source'
  await writeFile(f.catalog, JSON.stringify(invalid))
  const result = run(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unknown installed provider/)
  assert.doesNotMatch(result.stdout, /composition-verified/)
  assert.equal(await readFile(join(f.home, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8'), ORIGINAL)
})
