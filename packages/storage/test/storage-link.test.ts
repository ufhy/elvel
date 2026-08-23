import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readlink, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '@elvel/console'
import { Application } from '@elvel/core'
import { StorageLinkCommand } from '../src/console/storage-link.ts'

/**
 * Can this machine make a symbolic link at all?
 *
 * Windows refuses without a privilege it does not hand out by default — measured
 * here as `EPERM: operation not permitted, symlink`. The two tests that need a
 * real link are skipped there rather than failing for a reason that has nothing
 * to do with the code. CI runs on Linux, where they run.
 */
const canSymlink = await (async () => {
  const probeRoot = await mkdtemp(join(tmpdir(), 'elvel-symlink-probe-'))

  try {
    await symlink(probeRoot, join(probeRoot, 'link'))

    return true
  } catch {
    return false
  } finally {
    await rm(probeRoot, { recursive: true, force: true })
  }
})()

let app: Application
let kernel: Kernel
let root: string

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elvel-storage-link-'))
  app = new Application(root)
  kernel = new Kernel(app)
  kernel.register(StorageLinkCommand)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Run the command, capturing terminal output with colours stripped. */
async function run(): Promise<{ status: number; output: string }> {
  const originalLog = console.log
  const originalError = console.error
  const lines: string[] = []
  const collect = (...args: unknown[]) => lines.push(args.map(String).join(' '))

  console.log = collect
  console.error = collect

  try {
    const status = await kernel.run(['storage:link'])

    return { status, output: lines.join('\n').replace(ANSI, '') }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

describe('storage:link', () => {
  test.if(canSymlink)('links the public disk into the served directory', async () => {
    const { output } = await run()

    expect<boolean>(output.includes('Linked')).toBe(true)
    expect<string>(await readlink(app.publicPath('storage'))).toBe(app.storagePath('app/public'))
  })

  test.if(canSymlink)('an existing link is reported rather than replaced', async () => {
    await run()

    expect<boolean>((await run()).output.includes('already links to')).toBe(true)
  })

  /**
   * A path it cannot read is not a path with nothing in it.
   *
   * `lstat` failures were all swallowed as `null`, so the command went on to
   * create the link and failed three lines later with `EEXIST: file already
   * exists, symlink ...` — which says nothing about what is wrong or what to do.
   * Found on Windows, where a symlink committed to git and checked out without
   * symlink support answers `EACCES`.
   *
   * `ENOTDIR` stands in for it — a path whose parent is a file — which is what
   * POSIX answers. Windows answers `ENOENT` to the same question, meaning "not
   * there", which is exactly what the command is entitled to believe. So the
   * stand-in runs where it stands for something.
   */
  test.if(process.platform !== 'win32')(
    'a path it cannot inspect is reported, not overwritten',
    async () => {
      const file = join(root, 'public', 'not-a-directory')

      await Bun.write(file, 'a file, where a directory would have to be')

      app.config.set('filesystems.links', {
        [join(file, 'storage')]: app.storagePath('app/public')
      })

      const { output } = await run()

      expect<boolean>(output.includes('cannot be inspected')).toBe(true)
      expect<boolean>(output.includes('ENOTDIR')).toBe(true)

      // And it says nothing about having linked anything, because it did not.
      expect<boolean>(output.includes('Linked')).toBe(false)
    }
  )

  /** A real directory there is somebody's files, and stays. */
  test('a real directory is refused', async () => {
    const link = app.publicPath('storage')

    await Bun.write(join(link, 'keep.txt'), 'not mine to delete')

    const { output } = await run()

    expect<boolean>(output.includes('already exists and is not a link')).toBe(true)
    expect<string>(await Bun.file(join(link, 'keep.txt')).text()).toBe('not mine to delete')
  })
})
