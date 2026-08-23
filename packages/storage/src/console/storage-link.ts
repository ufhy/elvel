import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { Command } from '@elvel/console'

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
      /**
       * Only "not there" means not there.
       *
       * This swallowed every `lstat` failure as `null` and went on to create the
       * link — so a path it could not read looked like a path with nothing in it.
       * Measured on Windows, where a symlink committed to git and checked out
       * without symlink support answers `EACCES` to `lstat`: the command reported
       * `EEXIST: file already exists, symlink ...` from three lines further down,
       * which says nothing about what is wrong or what to do about it.
       *
       * "I cannot tell what is at this path" is not "nothing is at this path",
       * and the difference is worth a sentence to whoever has to fix it.
       */
      const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null

        return error
      })

      if (existing instanceof Error) {
        this.error(`[${link}] cannot be inspected: ${existing.code ?? existing.message}.`)
        continue
      }

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
