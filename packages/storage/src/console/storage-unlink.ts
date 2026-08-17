import { lstat, unlink } from 'node:fs/promises'
import { Command } from '@elyvel/console'

/**
 * `storage:unlink` — remove what `storage:link` created.
 *
 * Only ever removes a symlink. If the path is a real directory the command
 * refuses and says so: somebody has replaced the link with actual files, and
 * deleting those would be deleting the uploads rather than the shortcut to them.
 */
export class StorageUnlinkCommand extends Command {
  static override signature = 'storage:unlink'

  static override description = "Remove the symbolic links configured for the application's disks"

  async handle(): Promise<number> {
    const links = this.app.config.get<Record<string, string>>('filesystems.links', {
      [this.app.publicPath('storage')]: this.app.storagePath('app/public')
    })

    let removed = 0

    for (const link of Object.keys(links)) {
      const existing = await lstat(link).catch(() => null)

      if (existing === null) continue

      if (!existing.isSymbolicLink()) {
        this.error(`${link} is not a symbolic link. Leaving it alone.`)
        continue
      }

      await unlink(link)
      this.output.tag('INFO', `Removed ${link}.`)
      removed += 1
    }

    if (removed === 0) this.comment('No links to remove.')

    return 0
  }
}
