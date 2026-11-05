/**
 * Read a fixture value a test has already arranged to exist.
 *
 * A missing value then fails with this message and a stack at the read, not with a
 * later TypeError on some property of `undefined`.
 */
const MISSING_VALUE = 'expected this test value to exist'

export function must<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error(MISSING_VALUE)
  return value
}
