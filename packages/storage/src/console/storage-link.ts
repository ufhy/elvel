import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { Command } from '@elysian/console'

/**
 * `storage:link`
 *
 * Symlinks the public disk's root into the served directory, so files written to
 * it are reachable without a route that reads them. Laravel does the same, and for
 * the same reason: serving a file through the application costs a request that a
 * static file server would handle for free.
 */
export class StorageLinkCommand extends Command {
  static override signature =
    'storage:link {--force : Replace an existing link} {--relative : Create a relative link}'

  static override description = "Create the symbolic links configured for the application's disks"

  async handle(): Promise<number> {
    const links = this.app.config.get<Record<string, string>>('filesystems.links', {
      [this.app.publicPath('storage')]: this.app.storagePath('app/public')
    })

    for (const [link, target] of Object.entries(links)) {
      const existing = await lstat(link).catch(() => null)

      if (existing) {
        // Only a link is replaceable: a real directory there is somebody's files.
        if (!existing.isSymbolicLink()) {
          this.error(`[${link}] already exists and is not a link.`)
          continue
        }

        if (!this.flag('force')) {
          const current = await readlink(link).catch(() => '')

          this.comment(`[${link}] already links to [${current}]. Pass --force to replace it.`)
          continue
        }

        await unlink(link)
      }

      await mkdir(dirname(link), { recursive: true })
      await mkdir(target, { recursive: true })

      await symlink(this.flag('relative') ? relative(dirname(link), target) : target, link)

      this.output.tag('INFO', `Linked [${link}] to [${target}].`)
    }

    return 0
  }
}
