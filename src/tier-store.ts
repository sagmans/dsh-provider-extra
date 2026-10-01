/** Pair-sized records avoid cross-profile lost updates without a shared database or lock. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const DIRECTORY = 'provider-extra-service-tiers'
const RECORD_VERSION = 1
const MAX_RECORD_BYTES = 16 * 1024
const MAX_IDENTIFIER_BYTES = 1024
const DIRECTORY_MODE = 0o700
const RECORD_MODE = 0o600
const PUBLIC_PERMISSIONS = 0o077
const RECORD_KEYS = ['version', 'provider', 'model', 'tier']
const INVALID_INPUT = 'invalid service tier storage selection'
const READ_FAILURE = 'service tier storage record is unreadable or invalid'
const MISSING_HOME = 'service tier could not be saved; resolved profileContext.home is required'
const UNSAFE_DIRECTORY = 'service tier storage directory must be private and not a symlink'
const UNCERTAIN_WRITE = 'service tier was written, but durability could not be confirmed; reload the selection before retrying'
const WINDOWS_PLATFORM = 'win32'
const WINDOWS_UNSUPPORTED = 'service tier persistence is unsupported on Windows'

/** Undefined means no override; null deliberately suppresses configured policy. */
export interface TierStore {
  read(provider: string, model: string): string | null | undefined
  write(provider: string, model: string, tier: string | null): Promise<void>
}

/** Identity validation bounds hashing and rejects control characters in hand-edited records. */
function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Missing files alone permit configuration fallback; malformed state never enables paid tiers. */
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Reject redirected or public plugin directories without changing home permissions. */
function privateDirectory(directory: string): void {
  const info = lstatSync(directory)
  if (!info.isDirectory() || (info.mode & PUBLIC_PERMISSIONS) !== 0) throw new Error(UNSAFE_DIRECTORY)
}

/** File sync alone cannot make a created directory entry or renamed record crash-durable. */
async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}

/** The route owner supplies canonical tiers; storage owns only durability and record validation. */
export function createTierStore(home: string | undefined, validTier: (value: string) => boolean): TierStore {
  const directory = typeof home === 'string' && isAbsolute(home) ? join(home, DIRECTORY) : undefined
  const recordPath = (provider: string, model: string): string => {
    if (!validIdentifier(provider) || !validIdentifier(model)) throw new Error(INVALID_INPUT)
    if (directory === undefined) throw new Error(MISSING_HOME)
    const digest = createHash('sha256').update(JSON.stringify([provider, model])).digest('hex')
    return join(directory, digest + '.json')
  }
  return {
    read(provider, model) {
      if (directory === undefined) return undefined
      let descriptor: number | undefined
      try {
        const path = recordPath(provider, model)
        privateDirectory(directory)
        // Nonblocking/no-follow also reject FIFOs and symlinks without hanging a menu or request.
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const info = fstatSync(descriptor)
        if (!info.isFile() || info.size > MAX_RECORD_BYTES || (info.mode & PUBLIC_PERMISSIONS) !== 0) throw new Error(READ_FAILURE)
        const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1)
        let length = 0
        let count: number
        do {
          count = readSync(descriptor, bytes, length, bytes.length - length, null)
          length += count
        } while (count > 0 && length < bytes.length)
        if (length > MAX_RECORD_BYTES) throw new Error(READ_FAILURE)
        const record: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'))
        if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error(READ_FAILURE)
        const data = record as Record<string, unknown>
        if (Object.keys(data).length !== RECORD_KEYS.length || !RECORD_KEYS.every(key => Object.hasOwn(data, key))
          || data.version !== RECORD_VERSION || data.provider !== provider || data.model !== model
          || (data.tier !== null && (typeof data.tier !== 'string' || !validTier(data.tier)))) throw new Error(READ_FAILURE)
        return data.tier as string | null
      } catch (error) {
        if (missing(error)) return undefined
        throw new Error(READ_FAILURE)
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
      }
    },
    async write(provider, model, tier) {
      const path = recordPath(provider, model)
      if (tier !== null && (typeof tier !== 'string' || !validTier(tier))) throw new Error(INVALID_INPUT)
      // Windows cannot guarantee these POSIX privacy and directory-sync contracts; leave fallback state untouched.
      if (process.platform === WINDOWS_PLATFORM) throw new Error(WINDOWS_UNSUPPORTED)
      try {
        await mkdir(directory!, { mode: DIRECTORY_MODE })
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      privateDirectory(directory!)
      // Every writer covers a directory another process may have just created but not yet synced.
      await syncDirectory(home!)
      const temporary = join(directory!, '.' + randomUUID() + '.tmp')
      let created = false
      try {
        const file = await open(temporary, 'wx', RECORD_MODE)
        created = true
        try {
          await file.writeFile(JSON.stringify({ version: RECORD_VERSION, provider, model, tier }))
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, path)
        created = false
        try {
          await syncDirectory(directory!)
        } catch (cause) {
          // Rollback could overwrite a concurrent writer after this record became visible.
          throw new Error(UNCERTAIN_WRITE, { cause })
        }
      } finally {
        // Only uncommitted temporaries belong to this writer after a failed operation.
        if (created) await unlink(temporary).catch(error => { if (!missing(error)) throw error })
      }
    },
  }
}
