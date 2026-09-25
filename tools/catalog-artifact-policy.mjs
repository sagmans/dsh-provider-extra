/** Packaged examples must not become a second owner of personal model selections. */
const SYNTHETIC_PREFIX = 'example-'
const MODEL_FIELDS = new Set(['models', 'codexModels', 'extraModels', 'codexExtraModels'])

/** The policy checks declarations, not a private denylist of an operator's models. */
export function checkSelections(value, location, problems = []) {
  if (Array.isArray(value)) {
    for (const entry of value) checkSelections(entry, location, problems)
    return problems
  }
  if (!value || typeof value !== 'object') return problems
  const synthetic = identifier => typeof identifier === 'string' && identifier.startsWith(SYNTHETIC_PREFIX)
  if (value.catalog !== undefined) {
    const catalog = value.catalog
    if (!Array.isArray(catalog.providers) || catalog.providers.some(provider => !synthetic(provider.id) || typeof provider.source !== 'string')) {
      problems.push(location + ' contains a non-synthetic catalog provider selection')
    }
    if (catalog.default && (!synthetic(catalog.default.provider) || !synthetic(catalog.default.model))) {
      problems.push(location + ' contains a non-synthetic catalog default')
    }
  }
  for (const [key, member] of Object.entries(value)) {
    if (MODEL_FIELDS.has(key) && Array.isArray(member)) {
      for (const model of member) {
        const identifiers = typeof model === 'string' ? [model] : [model.id, ...(model.template ? [model.template] : []), ...(model.aliases ?? [])]
        if (identifiers.some(identifier => !synthetic(identifier))) problems.push(location + ' contains a non-synthetic model declaration')
      }
    }
    checkSelections(member, location, problems)
  }
  return problems
}
