/** Real homes exercise durable policy without touching profile configuration. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, type TestContext } from 'node:test'
import { createTierStore } from '../src/tier-store.ts'

const PROVIDER = 'example-provider'
const MODEL = 'example-model'
const PRIORITY = 'priority'
const STANDARD = 'default'
const DIRECTORY = 'provider-extra-service-tiers'
const PRIVATE_DIRECTORY = 0o700
const PRIVATE_FILE = 0o600
const PERMISSIONS = 0o777
const READ_FAILURE = 'service tier storage record is unreadable or invalid'
const UNCERTAIN_WRITE = 'service tier was written, but durability could not be confirmed; reload the selection before retrying'
const SYNC_FAILURE = 'simulated directory sync failure'
const WINDOWS_PLATFORM = 'win32'
const WINDOWS_UNSUPPORTED = 'service tier persistence is unsupported on Windows'
const validTier = (value: string): boolean => [PRIORITY, STANDARD, 'auto'].includes(value)

it('shares fresh pair selections and explicit provider defaults without modifying configuration', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tier-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = join(home, 'cordis.yml')
  const original = 'unrelated: preserved\n'
  await writeFile(config, original)
  const first = createTierStore(home, validTier)
  const second = createTierStore(home, validTier)
  assert.equal(first.read(PROVIDER, MODEL), undefined)
  await first.write(PROVIDER, MODEL, PRIORITY)
  assert.equal(second.read(PROVIDER, MODEL), PRIORITY)
  await second.write(PROVIDER, MODEL, null)
  assert.equal(first.read(PROVIDER, MODEL), null)
  assert.equal(createTierStore(home, validTier).read(PROVIDER, MODEL), null)
  assert.equal(await readFile(config, 'utf8'), original)
  const directory = join(home, DIRECTORY)
  assert.equal((await stat(directory)).mode & PERMISSIONS, PRIVATE_DIRECTORY)
  const records = await readdir(directory)
  assert.equal(records.length, 1)
  assert.match(records[0]!, /^[a-f0-9]{64}\.json$/)
  assert.equal((await stat(join(directory, records[0]!))).mode & PERMISSIONS, PRIVATE_FILE)
})

it('rejects malformed, oversized, mismatched, and noncanonical records without returning configured policy', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tier-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const store = createTierStore(home, validTier)
  await store.write(PROVIDER, MODEL, PRIORITY)
  const directory = join(home, DIRECTORY)
  const path = join(directory, (await readdir(directory))[0]!)
  const record = { version: 1, provider: PROVIDER, model: MODEL, tier: PRIORITY }
  const badRecords = [
    '{', 'null', '[]', JSON.stringify({ ...record, version: 2 }),
    JSON.stringify({ ...record, provider: 'other' }), JSON.stringify({ ...record, model: 'other' }),
    JSON.stringify({ ...record, tier: 'fast' }), JSON.stringify({ ...record, tier: false }),
    JSON.stringify({ ...record, extra: true }), JSON.stringify({ provider: PROVIDER, model: MODEL, tier: PRIORITY }),
    JSON.stringify(record) + ' '.repeat(32 * 1024),
  ]
  for (const value of badRecords) {
    await writeFile(path, value)
    assert.throws(() => store.read(PROVIDER, MODEL), { message: READ_FAILURE })
  }
  await store.write(PROVIDER, MODEL, STANDARD)
  assert.equal(store.read(PROVIDER, MODEL), STANDARD)
})

/** IPC gates ensure both real writers start together and every observed record is complete. */
async function concurrentWrites(t: TestContext, home: string, pairs: readonly (readonly [string, string, string])[]): Promise<void> {
  const store = createTierStore(home, validTier)
  let observations = 0
  const workers = pairs.map(([provider, model, tier]) => {
    const child = fork(new URL('./tier-store-worker.ts', import.meta.url), [home, provider, model, tier], {
      execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let errors = ''
    child.stderr!.on('data', value => { errors += String(value) })
    let readError: unknown
    const ready = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => { if (code !== 0) reject(new Error(errors)) })
      child.on('message', message => {
        if (message === 'ready') resolve()
        if (message === 'written') {
          try {
            assert.ok([PRIORITY, STANDARD].includes(store.read(provider, model) as string))
            observations++
          } catch (error) { readError = error }
        }
      })
    })
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => {
        if (readError) reject(readError)
        else if (code !== 0) reject(new Error(errors))
        else resolve()
      })
    })
    return { child, ready, done }
  })
  await Promise.all(workers.map(worker => worker.ready))
  for (const worker of workers) worker.child.send('start')
  await Promise.all(workers.map(worker => worker.done))
  assert.ok(observations > pairs.length)
}

it('retains different pair writes from simultaneous separate processes with safe collision-resistant paths', { timeout: 15_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'tier-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const pairs = [['../example-provider', 'a/b', PRIORITY], ['../example-provider/a', 'b', STANDARD]] as const
  await concurrentWrites(t, home, pairs)
  const reader = createTierStore(home, validTier)
  assert.equal(reader.read(pairs[0][0], pairs[0][1]), PRIORITY)
  assert.equal(reader.read(pairs[1][0], pairs[1][1]), STANDARD)
  const records = await readdir(join(home, DIRECTORY))
  assert.equal(records.length, 2)
  for (const name of records) assert.match(name, /^[a-f0-9]{64}\.json$/)
})

it('exposes only complete same-pair records while separate processes race', { timeout: 15_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'tier-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const store = createTierStore(home, validTier)
  await store.write(PROVIDER, MODEL, PRIORITY)
  await concurrentWrites(t, home, [[PROVIDER, MODEL, PRIORITY], [PROVIDER, MODEL, STANDARD]])
  assert.ok([PRIORITY, STANDARD].includes(store.read(PROVIDER, MODEL) as string))
  await store.write(PROVIDER, MODEL, null)
  assert.equal(createTierStore(home, validTier).read(PROVIDER, MODEL), null)
  assert.equal((await readdir(join(home, DIRECTORY))).length, 1)
})


it('preserves the last selection on write failure and cleans exclusive temporaries after rename failure', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tier-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const store = createTierStore(home, validTier)
  await store.write(PROVIDER, MODEL, PRIORITY)
  const directory = join(home, DIRECTORY)
  const records = await readdir(directory)
  await chmod(directory, 0o500)
  try {
    await assert.rejects(store.write(PROVIDER, MODEL, STANDARD), { code: 'EACCES' })
    assert.equal(store.read(PROVIDER, MODEL), PRIORITY)
    assert.deepEqual(await readdir(directory), records)
  } finally {
    await chmod(directory, PRIVATE_DIRECTORY)
  }
  const recordPath = join(directory, records[0]!)
  await unlink(recordPath)
  await mkdir(recordPath)
  await assert.rejects(store.write(PROVIDER, MODEL, STANDARD), { code: 'EISDIR' })
  assert.deepEqual(await readdir(directory), records)
})

it('rejects redirected and public state without touching symlink targets', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tier-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const store = createTierStore(home, validTier)
  const directory = join(home, DIRECTORY)
  const outside = join(home, 'unrelated')
  await mkdir(outside, { mode: PRIVATE_DIRECTORY })
  await symlink(outside, directory)
  assert.throws(() => store.read(PROVIDER, MODEL), { message: READ_FAILURE })
  await assert.rejects(store.write(PROVIDER, MODEL, PRIORITY), /private and not a symlink/)
  assert.deepEqual(await readdir(outside), [])
  await unlink(directory)
  await store.write(PROVIDER, MODEL, PRIORITY)
  const recordPath = join(directory, (await readdir(directory))[0]!)
  await chmod(recordPath, 0o644)
  assert.throws(() => store.read(PROVIDER, MODEL), { message: READ_FAILURE })
  await chmod(recordPath, PRIVATE_FILE)
  await chmod(directory, 0o755)
  assert.throws(() => store.read(PROVIDER, MODEL), { message: READ_FAILURE })
  await assert.rejects(store.write(PROVIDER, MODEL, STANDARD), /private and not a symlink/)
  await chmod(directory, PRIVATE_DIRECTORY)
  const target = join(outside, 'target.json')
  const original = await readFile(recordPath, 'utf8')
  await writeFile(target, original, { mode: PRIVATE_FILE })
  await unlink(recordPath)
  await symlink(target, recordPath)
  assert.throws(() => store.read(PROVIDER, MODEL), { message: READ_FAILURE })
  await store.write(PROVIDER, MODEL, STANDARD)
  assert.equal(store.read(PROVIDER, MODEL), STANDARD)
  assert.equal(await readFile(target, 'utf8'), original)
})

it('rejects invalid identities, tiers, and unresolved homes before creating storage', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tier-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const store = createTierStore(home, validTier)
  for (const [provider, model] of [['', MODEL], [PROVIDER, ' '], ['a'.repeat(2048), MODEL], [PROVIDER, '\u0000']]) {
    await assert.rejects(store.write(provider!, model!, PRIORITY), /invalid service tier storage selection/)
  }
  await assert.rejects(store.write(PROVIDER, MODEL, 'fast'), /invalid service tier storage selection/)
  for (const missing of [undefined, '', 'relative-home']) {
    const unavailable = createTierStore(missing, validTier)
    assert.equal(unavailable.read(PROVIDER, MODEL), undefined)
    await assert.rejects(unavailable.write(PROVIDER, MODEL, PRIORITY), /resolved profileContext.home is required/)
  }
  assert.deepEqual(await readdir(home), [])
})


it('syncs newly created directory entries and reports post-rename uncertainty without rolling back concurrent writes', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tier-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const store = createTierStore(home, validTier)
  const descriptor = await open(home, 'r')
  const prototype = Object.getPrototypeOf(descriptor) as FileHandle
  const originalSync = prototype.sync
  await descriptor.close()
  const homeIdentity = await stat(home)
  let homeSynced = false
  let failNextCommit = true
  t.mock.method(prototype, 'sync', async function (this: FileHandle) {
    const identity = await this.stat()
    if (identity.isDirectory()) {
      if (identity.dev === homeIdentity.dev && identity.ino === homeIdentity.ino) {
        assert.ok((await stat(join(home, DIRECTORY))).isDirectory())
        await originalSync.call(this)
        homeSynced = true
        return
      }
      assert.equal(homeSynced, true, 'new store directory must survive before a selection can be acknowledged')
      if (failNextCommit) {
        failNextCommit = false
        assert.equal(store.read(PROVIDER, MODEL), null, 'rename has already published the explicit clear')
        await store.write(PROVIDER, MODEL, STANDARD)
        throw new Error(SYNC_FAILURE)
      }
    }
    await originalSync.call(this)
  })
  await assert.rejects(store.write(PROVIDER, MODEL, null), { message: UNCERTAIN_WRITE })
  assert.equal(homeSynced, true)
  assert.equal(store.read(PROVIDER, MODEL), STANDARD)
  assert.equal((await readdir(join(home, DIRECTORY))).length, 1)
})

it('fails before publishing when the home directory cannot be synchronized', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tier-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const store = createTierStore(home, validTier)
  await store.write(PROVIDER, MODEL, PRIORITY)
  const descriptor = await open(home, 'r')
  const prototype = Object.getPrototypeOf(descriptor) as FileHandle
  const originalSync = prototype.sync
  await descriptor.close()
  t.mock.method(prototype, 'sync', async function (this: FileHandle) {
    if ((await this.stat()).isDirectory()) throw new Error(SYNC_FAILURE)
    await originalSync.call(this)
  })
  await assert.rejects(store.write(PROVIDER, MODEL, null), { message: SYNC_FAILURE })
  assert.equal(store.read(PROVIDER, MODEL), PRIORITY)
  assert.equal((await readdir(join(home, DIRECTORY))).length, 1)
})


it('rejects Windows persistence without creating state that disables configured fallback', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tier-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: WINDOWS_PLATFORM })
  try {
    const store = createTierStore(home, validTier)
    assert.equal(store.read(PROVIDER, MODEL), undefined)
    await assert.rejects(store.write(PROVIDER, MODEL, null), { message: WINDOWS_UNSUPPORTED })
    assert.deepEqual(await readdir(home), [])
    assert.equal(store.read(PROVIDER, MODEL), undefined)
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})
