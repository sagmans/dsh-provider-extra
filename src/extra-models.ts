/**
 * Declared models, shared by every route this plugin owns.
 *
 * Two declarations share this module. An extra adds an id the installed
 * catalog predates, cloning a template sibling's wire behavior instead of
 * restating it; a declaration that cannot resolve lands in the route's model
 * diagnostics beside its serviceable models, because one mistyped template
 * must not silence a whole route. A whitelist instead selects which of the
 * resolved models a route serves, and refuses the whole route when it names an
 * id nothing provides — a configuration typo there is a broken deployment, not
 * a diagnosable one-model problem.
 *
 * @module dsh-provider-extra/extra-models
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * One declared model: an id plus the catalog sibling it clones.
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

/**
 * Narrow one route's resolved models to a declared whitelist and put them in
 * the declared order. Absent means the route serves everything it resolved;
 * present means exactly those ids, so the picker and the gateway agree.
 * Resolution order — the installed catalog, then the route's shipped extras,
 * then the declared ones — stays the authority on which id exists, and a
 * whitelist may therefore name a catalog id, a shipped extra, or a declared
 * extra.
 * @param route - route id the refusal names.
 * @param models - resolved catalog and extra models, in resolution order.
 * @param whitelist - exact ids to serve, or undefined to serve every model.
 * @returns the selected models in declared order.
 * @throws {LlmError} when the whitelist names an id nothing resolves; failing
 * the route loud is the only alternative that cannot silently serve less than
 * the deployment asked for.
 */
export function selectWhitelistedModels(
  route: string,
  models: readonly Model<Api>[],
  whitelist?: readonly string[],
): Model<Api>[] {
  if (whitelist === undefined) return [...models]
  const byId = new Map(models.map(model => [model.id, model]))
  const selected: Model<Api>[] = []
  const seen = new Set<string>()
  for (const id of whitelist) {
    // A repeated id is one model, kept at its first position: advertising the
    // same id twice would offer the picker two entries no request distinguishes.
    if (seen.has(id)) continue
    seen.add(id)
    const model = byId.get(id)
    if (model === undefined) {
      throw new LlmError(
        'dsh-provider-extra: route "' + route + '" declares model "' + id + '" in its model selection,'
        + ' but neither the installed pi-ai catalog nor an extra model declaration provides it',
        'UNKNOWN_MODEL',
      )
    }
    selected.push(model)
  }
  return selected
}
