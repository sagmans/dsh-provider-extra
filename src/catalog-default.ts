/** Defaults share the profile Config owner rather than the legacy settings namespace. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { compileCatalog } from './catalog.ts'
import type { CatalogSelection, CatalogSnapshot } from './catalog.ts'

const EDITOR_SERVICE = 'configEditor'
const PERSISTENCE_UNAVAILABLE = 'CONFIG_PERSISTENCE_UNAVAILABLE'

/** Structural capability matches the public source configEditor API without adding a peer. */
interface ConfigEditor {
  edit(entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

/** A detached selection prevents callers from mutating the catalog's default. */
export function catalogDefault(owner: Context, snapshot: CatalogSnapshot, requireOwnership?: () => void): {
  currentSelection(): CatalogSelection
  saveSelection(next: unknown): Promise<void>
} {
  return {
    currentSelection() {
      requireOwnership?.()
      if (snapshot.selection === null) {
        throw new LlmError('dsh-provider-extra: the catalog selects no default model', 'NO_DEFAULT_MODEL')
      }
      return { ...snapshot.selection }
    },
    async saveSelection(next) {
      requireOwnership?.()
      const selection = snapshot.resolveSelection(next)
      // EntryTree.write may be a no-op or target a generated document; only the
      // profile editor guarantees validation, locking, rollback and reconciliation.
      const entry: unknown = (owner.fiber as typeof owner.fiber & { entry?: unknown }).entry
      const editor = owner.get(EDITOR_SERVICE) as ConfigEditor | undefined
      if (entry === undefined || typeof editor?.edit !== 'function') {
        throw new LlmError(
          'dsh-provider-extra: this host cannot persist catalog.default; edit the owning profile Config',
          PERSISTENCE_UNAVAILABLE,
        )
      }
      await editor.edit(entry, (current) => {
        requireOwnership?.()
        // Revalidation inside the editor's lock prevents a stale picker from
        // restoring membership removed by another profile edit.
        const latest = compileCatalog(current.catalog)
        if (latest === undefined) {
          throw new LlmError('dsh-provider-extra: the owning Config no longer contains a catalog', 'CATALOG_OWNER_CHANGED')
        }
        const updated = { ...latest.config, default: latest.resolveSelection(selection) }
        compileCatalog(updated)
        return { ...current, catalog: updated }
      })
    },
  }
}
