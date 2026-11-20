import { LlmError } from '@deepseek-ai/dsh-llm'

type HostFailureCode = ConstructorParameters<typeof LlmError>[1]

/**
 * Raise a failure whose code belongs to this plugin, not to the harness list.
 *
 * Harness 0.2.2-rc.5 narrows the constructor to its built-in codes, while the
 * runtime still accepts any non-empty string and older verified releases have no
 * re-raise helper. The plugin's own codes are a documented contract that callers
 * and tests match on, so the type is widened here once instead of renaming them.
 */
export function pluginLlmError(message: string, code: string): LlmError {
  return new LlmError(message, code as HostFailureCode)
}
