/** Stock npm CLI dispatch catches registry and process-scope mismatches that structural fixtures cannot. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire, findPackageJSON } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI_PACKAGE = '@deepseek-ai/dsh'
const CLI_MANIFEST_PATH = realpathSync(join(ROOT, 'node_modules', CLI_PACKAGE, 'package.json'))
const CLI_MANIFEST = JSON.parse(readFileSync(CLI_MANIFEST_PATH, 'utf8'))
const CLI = join(dirname(CLI_MANIFEST_PATH), CLI_MANIFEST.bin.dsh)
const CLI_REQUIRE = createRequire(CLI_MANIFEST_PATH)
const PLUGIN = '@sagmans/dsh-provider-extra'
const PI_AI = '@earendil-works/pi-ai'
const PREFIX = 'dsh-headless-tiers-'
const PROVIDER = 'example-openai-smoke'
const MODEL = 'example-tier-smoke'
const KEY_REF = 'TIER_SMOKE_KEY'
const KEY = 'sk-local-tier-smoke'
const TIMEOUT_MS = 45_000
const TEST_TIMEOUT_MS = 180_000
const PRIVATE_DIRECTORY = 0o700
const PRIVATE_FILE = 0o600
const TEXT = 'pong'
const ITEM = { type: 'message', id: 'example-message', role: 'assistant', content: [{ type: 'output_text', text: TEXT, annotations: [] }] }
const RESPONSE = { id: 'example-response', status: 'completed', output: [ITEM], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
const EVENTS = [
  { type: 'response.created', response: { ...RESPONSE, status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { ...ITEM, content: [] } },
  { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: TEXT },
  { type: 'response.output_text.done', output_index: 0, content_index: 0, text: TEXT },
  { type: 'response.content_part.done', output_index: 0, content_index: 0, part: ITEM.content[0] },
  { type: 'response.output_item.done', output_index: 0, item: ITEM },
  { type: 'response.completed', response: RESPONSE },
]
const SSE = EVENTS.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')
const DISABLED = ['llm-deepseek', 'llm-pi-ai', 'llm-deepseek-account', 'agent-default-model', 'session-title-llm']

/** Public entries, not exported package.json assumptions, identify the CLI's exact dependency generations. */
function peerRoot(name) {
  // Native ESM package discovery honors pi-ai's import-only entry, which createRequire cannot resolve.
  if (name === PI_AI) return dirname(realpathSync(findPackageJSON(name, CLI_MANIFEST_PATH)))
  let directory = dirname(CLI_REQUIRE.resolve(name))
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return directory
    const parent = dirname(directory)
    assert.notEqual(parent, directory, 'No package manifest owns ' + name)
    directory = parent
  }
}

test('stock headless CLI keeps fresh and resumed tier overrides invocation-local', { timeout: TEST_TIMEOUT_MS }, async () => {
  const home = mkdtempSync(join(tmpdir(), PREFIX))
  chmodSync(home, PRIVATE_DIRECTORY)
  const workspace = join(home, 'workspace')
  const candidate = join(home, 'provider-candidate')
  const store = join(home, 'provider-extra-service-tiers')
  const shared = join(home, 'cordis.patch.yml')
  const requests = []
  let session
  let child
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push({ body: JSON.parse(body), authorization: request.headers.authorization })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(SSE)
    })
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    mkdirSync(workspace)
    mkdirSync(candidate)
    cpSync(join(ROOT, 'dist'), join(candidate, 'dist'), { recursive: true })
    for (const file of ['cordis.patch.yml', 'headless.patch.yml']) cpSync(join(ROOT, file), join(candidate, file))
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    writeFileSync(join(candidate, 'package.json'), JSON.stringify(manifest))
    for (const name of Object.keys(manifest.peerDependencies)) {
      const link = join(candidate, 'node_modules', name)
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(peerRoot(name), link, 'junction')
    }
    const profile = join(home, 'profiles', 'headless')
    mkdirSync(join(profile, 'node_modules', '@sagmans'), { recursive: true })
    symlinkSync(candidate, join(profile, 'node_modules', PLUGIN), 'junction')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'example-tier-smoke', private: true,
      dependencies: { [PLUGIN]: 'link:' + candidate },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', PLUGIN] } },
    }))
    writeFileSync(join(profile, 'cordis.yml'), '[]\n')
    writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
    const metadata = { api: 'openai-responses', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 256 }
    const config = { catalog: { version: 1, providers: [{ id: PROVIDER, name: PROVIDER, source: 'openai',
      baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', auth: { apiKeyRef: KEY_REF },
      models: [{ id: MODEL, name: MODEL, metadata }],
    }], default: { provider: PROVIDER, model: MODEL } },
      serviceTierSelections: [{ provider: PROVIDER, model: MODEL, tier: 'default' }],
    }
    const save = () => writeFileSync(shared, JSON.stringify([...DISABLED.map(id => ({ id, disabled: true })), { id: 'dsh-provider-extra', config }]))
    save()
    // A conflicting configured default proves real shared records stay authoritative and unchanged.
    mkdirSync(store, { mode: PRIVATE_DIRECTORY })
    const digest = createHash('sha256').update(JSON.stringify([PROVIDER, MODEL])).digest('hex')
    writeFileSync(join(store, digest + '.json'), JSON.stringify({ version: 1, provider: PROVIDER, model: MODEL, tier: 'priority' }), { mode: PRIVATE_FILE })
    const stored = () => readdirSync(store).sort().map(name => [name, readFileSync(join(store, name), 'utf8')])

    /** Separate real launches ensure no retained process scope can impersonate persistence. */
    async function invoke(flags, expected, success = true) {
      const before = requests.length
      const savedConfig = readFileSync(shared, 'utf8')
      const savedStore = stored()
      child = spawn(process.execPath, [CLI, '--profile', 'headless', '--patch', join(candidate, 'headless.patch.yml'),
        '--json', ...(session === undefined ? [] : ['--session-id', session]), ...flags, 'Reply with exactly pong.'], {
        cwd: workspace,
        env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, DO_NOT_TRACK: '1', DSH_TELEMETRY_DISABLED: '1', [KEY_REF]: KEY },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', data => { stdout += data })
      child.stderr.on('data', data => { stderr += data })
      const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
      let result
      try {
        result = await new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        })
      } finally { clearTimeout(timer) }
      const diagnostic = JSON.stringify({ flags, result, stdout: stdout.slice(-2000), stderr })
      assert.equal(result.signal, null, diagnostic)
      assert.equal(readFileSync(shared, 'utf8'), savedConfig, 'Invocation changed shared configuration')
      assert.deepEqual(stored(), savedStore, 'Invocation changed saved tier records')
      if (!success) {
        assert.notEqual(result.code, 0, diagnostic)
        assert.equal(requests.length, before, 'Rejected override reached provider')
        assert.match(stderr + stdout, /service tier|service-tier/i)
        return
      }
      assert.equal(result.code, 0, diagnostic)
      const events = stdout.trim().split('\n').map(line => JSON.parse(line))
      const announced = events.find(event => event.type === 'session')?.sessionId
      assert.ok(announced, diagnostic)
      if (session !== undefined) assert.equal(announced, session, 'Resume changed the invoking root identity')
      session = announced
      assert.match(stdout, /pong/)
      assert.ok(requests.length > before, 'No local provider request')
      for (const request of requests.slice(before)) {
        assert.equal(request.body.service_tier, expected, diagnostic)
        assert.equal(request.body.model, MODEL)
        assert.equal(request.authorization, 'Bearer ' + KEY)
      }
    }

    await invoke([], 'priority')
    await invoke(['--service-tier=standard'], 'default')
    await invoke(['--service-tier=fast'], 'priority')
    await invoke(['--service-tier=auto'], 'auto')
    await invoke(['--service-tier=provider-default'], undefined)
    await invoke([], 'priority')
    await invoke(['--service-tier=ultrafast'], undefined, false)
    config.catalog.providers[0].source = 'openrouter'
    metadata.api = 'openai-completions'
    save()
    await invoke(['--service-tier=fast'], undefined, false)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise(resolve => child.once('close', resolve))
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    const target = realpathSync(home)
    assert.equal(dirname(target), realpathSync(tmpdir()))
    assert.ok(basename(target).startsWith(PREFIX))
    rmSync(target, { recursive: true, force: true })
  }
})
