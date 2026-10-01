/** Headless-only argument ownership leaves the stock runner and its durable session protocol unchanged. */
import { parseArgs } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { isServiceTierOverride } from './service-tiers.ts'
import type { TierInvocationAgents } from './tier-invocation.ts'

export const name = 'provider-extra-headless-startup'
export const inject = ['cmdlineArgs', 'appExit', 'agents', 'providerTierInvocation']
const STARTUP_SERVICE = 'headlessStartup'
const SUCCESS = 0
const USAGE_ERROR = 1
const SEPARATOR = '--'
const STDIN_TASK = '-'
const JSON_FLAG = '--json'
const VALUE_FLAGS = new Set(['--session-id', '--service-tier'])
const TASK_REQUIRED = 'a task is required, for example: dsh --profile headless "run the tests"'
const HELP = "Usage: dsh --profile headless [options] [task...]\n\nAnswer one task and exit; the answer goes to stdout and diagnostics to stderr.\n\nOptions:\n  --json                 write newline-delimited run events to stdout instead of the final message\n  --session-id <id>      adopt the persisted Session with this id; an unknown id is an error\n  --service-tier <tier>  invocation only: auto, default, priority, fast, standard, provider-default\n  -h, --help             show this help\n\nThe task text joins multiple words with spaces; - reads stdin.\n\nExamples:\n  dsh --profile headless \"run the tests\"\n  echo \"run the tests\" | dsh --profile headless\n  dsh --profile headless --json \"run the tests\"\n  dsh --profile headless --session-id session-… \"continue\"\n"

/** Only a real flag before the separator can opt parse failures into machine-readable output. */
function jsonRequested(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === SEPARATOR) return false
    if (args[index] === JSON_FLAG) return true
    if (VALUE_FLAGS.has(args[index])) index += 1
  }
  return false
}

/** Stock required options accept dash-prefixed values; native strict parsing needs their explicit equals form. */
function nativeArgs(args: readonly string[]): string[] {
  const normalized: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === SEPARATOR) {
      normalized.push(...args.slice(index))
      break
    }
    normalized.push(VALUE_FLAGS.has(argument) && index + 1 < args.length
      ? argument + '=' + args[++index] : argument)
  }
  return normalized
}

/** Publishing this public service starts the stock runner, so all syntax validation precedes publication. */
export function apply(ctx: Context): void {
  const cmdline = ctx.get('cmdlineArgs') as { get(): readonly string[] } | undefined
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (!cmdline || !exit) throw new Error('dsh --profile headless: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts')
  const args = cmdline.get()
  let parsed: {
    values: { json?: boolean; 'session-id'?: string; 'service-tier'?: string; help?: boolean }
    positionals: string[]
  }
  try {
    parsed = parseArgs({ args: nativeArgs(args), allowPositionals: true, strict: true, options: {
      json: { type: 'boolean' },
      'session-id': { type: 'string' },
      'service-tier': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } })
  } catch (error) {
    reject(error instanceof Error ? error.message : String(error))
    return
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stdout.write(HELP)
    exit(SUCCESS)
    return
  }
  const task = positionals.length === 0 ? undefined : positionals.join(' ')
  const sessionId = values['session-id']
  const override = values['service-tier']
  if (positionals.length > 1 && positionals.includes(STDIN_TASK)) return reject('`-` must be the only task argument')
  if ((task !== undefined && task.trim() === '') || (task === undefined && process.stdin.isTTY)) return reject(TASK_REQUIRED)
  if (sessionId !== undefined && sessionId.trim() === '') return reject('--session-id requires a non-empty session id')
  if (override !== undefined && !isServiceTierOverride(override)) return reject('unsupported --service-tier: ' + override)
  const agents = ctx.get('agents') as TierInvocationAgents | undefined
  const controller = ctx.get('providerTierInvocation')
  if (!agents || !controller) throw new Error('headless service tiers require agents and providerTierInvocation')
  ctx.effect(() => controller.activate(override, sessionId, agents))
  ctx.provide(STARTUP_SERVICE, { task, sessionId, json: values.json === true })

  /** Usage failures remain launcher-owned exits instead of failing plugin mounts or starting requests. */
  function reject(message: string): void {
    if (jsonRequested(args)) process.stdout.write(JSON.stringify({ type: 'error', message }) + '\n')
    else process.stderr.write('error: ' + message + '\n')
    exit!(USAGE_ERROR)
  }
}
