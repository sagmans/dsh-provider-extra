/** Ambiguous labels or free text must never choose another configured credential owner. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { choiceByWords, pickerQuestion, resolveChoice, words } from '../src/login-choice.ts'
import type { LoginChoice } from '../src/login-contract.ts'

const FIRST: LoginChoice = { providerId: 'Team-A', providerName: 'Shared provider', authType: 'api_key', methodLabel: 'API key' }
const SECOND: LoginChoice = { ...FIRST, providerId: 'team-b' }
const CASE_DISTINCT: LoginChoice = { ...FIRST, providerId: 'team-a' }
const CHOICES = [FIRST, SECOND]
const answer = (custom: string) => ({ answers: [{ id: 'provider', selected: [], custom }] })

test('picker free text resolves the requested route and method rather than first matching method', () => {
  assert.equal(resolveChoice(CHOICES, answer(SECOND.providerId + ' key')), SECOND)
  assert.equal(resolveChoice(CHOICES, answer('not-configured key')), undefined)
  assert.equal(resolveChoice(CHOICES, answer('key')), undefined, 'an ambiguous method alone names no owner')
})

test('duplicate display labels include route identity and resolve the chosen owner', () => {
  const question = pickerQuestion(CHOICES)
  const labels = question.options!.map(option => option.label)
  assert.equal(new Set(labels).size, CHOICES.length)
  assert.ok(labels[0]!.includes(FIRST.providerId))
  assert.ok(labels[1]!.includes(SECOND.providerId))
  assert.equal(resolveChoice(CHOICES, { answers: [{ id: question.id, selected: [labels[1]!] }] }), SECOND)
})

test('configured route IDs retain exact casing without breaking unambiguous legacy case-insensitive input', () => {
  assert.equal(choiceByWords([FIRST, CASE_DISTINCT], words(FIRST.providerId + ' KEY')), FIRST)
  assert.equal(choiceByWords([FIRST, CASE_DISTINCT], words(CASE_DISTINCT.providerId + ' key')), CASE_DISTINCT)
  assert.equal(choiceByWords(CHOICES, words('TEAM-B KEY')), SECOND)
  assert.equal(choiceByWords([FIRST, CASE_DISTINCT], words('TEAM-A key')), undefined)
})

test('unknown method words never silently begin OAuth', () => {
  const oauth: LoginChoice = { ...FIRST, authType: 'oauth', methodLabel: 'OAuth' }
  assert.equal(choiceByWords([oauth, FIRST], words(FIRST.providerId + ' typo')), undefined)
  assert.equal(resolveChoice([oauth, FIRST], answer(FIRST.providerId + ' typo')), undefined)
})
