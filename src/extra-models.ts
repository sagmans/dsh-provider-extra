/**
 * Settings-declared model additions, shared by every route this plugin owns.
 *
 * The installed catalog stays the authority on wire behavior: an extra only
 * names an id the catalog predates, and clones a template sibling's API quirks,
 * costs, and limits instead of restating them. A declaration that cannot
 * resolve lands in the route's model diagnostics beside its serviceable
 * models, because one mistyped template must not silence a whole route.
 *
 * @module dsh-provider-extra/extra-models
 */

import type { Api, Model } from '@earendil-works/pi-ai'

/**
 * One settings-declared model: an id plus the catalog sibling it clones.
 * `template` stays optional because a route may ship its own default; a route
 * that ships none reports the omission rather than guessing a sibling.
 */
export interface ExtraModelSpec {
  /** Model id sent to the provider. */
  id: string
  /** Display name for selectors; defaults to the template sibling's name. */
  name?: string
  /** Catalog sibling to inherit wire behavior from. */
  template?: string
}

/**
 * Resolve declared extras against the installed catalog. Later specs win over
 * earlier ones by id, so a settings entry reshapes a shipped default under the
 * same id; an id the catalog itself ships stays with the catalog.
 * @param catalog - installed catalog models to clone wire behavior from.
 * @param specs - declared extras, shipped defaults first.
 * @param fallbackTemplate - catalog id used when a spec names no template; a
 * route whose gateway serves no representative sibling omits it, so the
 * omission is reported instead of cloned from an unrelated provider.
 * @returns the resolved extras and per-model failure diagnostics.
 */
export function resolveExtraModels(
  catalog: readonly Model<Api>[],
  specs: readonly ExtraModelSpec[],
  fallbackTemplate?: string,
): { models: Model<Api>[]; modelErrors: Map<string, string> } {
  const models: Model<Api>[] = []
  const modelErrors = new Map<string, string>()
  const shipped = new Set(catalog.map(model => model.id))
  const byId = new Map<string, ExtraModelSpec>()
  for (const spec of specs) byId.set(spec.id, spec)
  for (const spec of byId.values()) {
    if (spec.id.length === 0) {
      modelErrors.set(spec.id, 'dsh-provider-extra: an extra model has an empty id')
      continue
    }
    if (shipped.has(spec.id)) continue
    const templateId = spec.template ?? fallbackTemplate
    if (templateId === undefined) {
      modelErrors.set(spec.id, 'dsh-provider-extra: extra model "' + spec.id + '" names no template'
        + ' and this route ships no default sibling to clone')
      continue
    }
    const template = catalog.find(model => model.id === templateId)
    if (template === undefined) {
      modelErrors.set(spec.id, 'dsh-provider-extra: extra model "' + spec.id + '" names template "' + templateId + '",'
        + ' which the installed catalog does not describe')
      continue
    }
    models.push({ ...template, id: spec.id, name: spec.name ?? template.name })
  }
  return { models, modelErrors }
}
