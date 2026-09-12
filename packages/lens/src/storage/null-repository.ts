import type { EntriesRepository } from '../contracts.ts'
import type { EntryResult } from '../entry-result.ts'
import type { EntryUpdate } from '../entry-update.ts'

/**
 * Storage that keeps nothing, for an application running only the bar.
 *
 * `LENS_BAR=true` with no tables is a supported way to use this package — the
 * bar reads a ring in memory and never asks a repository anything. But the
 * recorder still ends every unit of work by handing its batch to storage, and
 * the database driver would answer with "no such table" and report it.
 *
 * Reporting a missing table is right when somebody asked for Lens. It is noise
 * when they asked only for the bar, so that case gets a repository that agrees
 * to be handed entries and does nothing with them. The alternative was a branch
 * inside `store()`, which would make the recorder know about the bar.
 */
export class NullEntriesRepository implements EntriesRepository {
  async find(): Promise<EntryResult | undefined> {
    return undefined
  }

  async get(): Promise<EntryResult[]> {
    return []
  }

  async count(): Promise<number> {
    return 0
  }

  async store(): Promise<void> {
    //
  }

  async update(): Promise<EntryUpdate[]> {
    return []
  }

  async monitoring(): Promise<string[]> {
    return []
  }

  async isMonitoring(): Promise<boolean> {
    return false
  }

  async monitor(): Promise<void> {
    //
  }

  async stopMonitoring(): Promise<void> {
    //
  }
}
