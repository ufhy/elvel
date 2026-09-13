import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Glob } from 'bun'

/**
 * Files that are not on a configured disk.
 *
 * A generator writing a stub, a command reading a fixture, a deploy script.
 * Every one of those reached for `node:fs` directly and re-decided what "make
 * the directory if it is missing" means — so this is that decision, once.
 *
 * Absolute paths, no root, no visibility: a disk is the abstraction for storage
 * an application owns, and this is deliberately not one.
 *
 * Here rather than in `@elvel/storage` because the console is the largest
 * caller and storage depends on the console — putting it there would have built
 * the cycle the layering exists to avoid.
 */
export const Files = {
  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists()
  },

  async missing(path: string): Promise<boolean> {
    return !(await Files.exists(path))
  },

  async get(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  },

  /** Or an error naming the path, for a caller that cannot carry on without it. */
  async getOrFail(path: string): Promise<string> {
    const contents = await Files.get(path)

    if (contents === null) throw new Error(`File [${path}] does not exist.`)

    return contents
  },

  async bytes(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await Bun.file(path).arrayBuffer())
    } catch {
      return null
    }
  },

  async json<T = unknown>(path: string): Promise<T | null> {
    const contents = await Files.get(path)

    if (contents === null) return null

    try {
      return JSON.parse(contents) as T
    } catch {
      return null
    }
  },

  /** The lines, without the trailing empty one a final newline produces. */
  async lines(path: string): Promise<string[]> {
    const contents = await Files.get(path)

    if (contents === null) return []

    const lines = contents.split(/\r?\n/)

    if (lines[lines.length - 1] === '') lines.pop()

    return lines
  },

  /** Writes the file, making the directory first — the whole reason this exists. */
  async put(path: string, contents: string | Uint8Array): Promise<void> {
    await Files.ensureDirectoryExists(dirname(path))
    await writeFile(path, contents)
  },

  async append(path: string, contents: string): Promise<void> {
    await Files.ensureDirectoryExists(dirname(path))
    await writeFile(path, contents, { flag: 'a' })
  },

  async prepend(path: string, contents: string): Promise<void> {
    await Files.put(path, `${contents}${(await Files.get(path)) ?? ''}`)
  },

  /**
   * Swap text in a file that is already there.
   *
   * A missing file is left alone rather than created: this is for editing
   * something a scaffold wrote, and creating it would produce a file holding
   * nothing but the replacement.
   */
  async replaceInFile(path: string, search: string | RegExp, replace: string): Promise<boolean> {
    const contents = await Files.get(path)

    if (contents === null) return false

    const updated =
      typeof search === 'string'
        ? contents.replaceAll(search, replace)
        : contents.replace(search, replace)

    if (updated === contents) return false

    await writeFile(path, updated)

    return true
  },

  async delete(...paths: string[]): Promise<void> {
    for (const path of paths) await unlink(path).catch(() => {})
  },

  async copy(from: string, to: string): Promise<void> {
    await Files.ensureDirectoryExists(dirname(to))
    await copyFile(from, to)
  },

  async move(from: string, to: string): Promise<void> {
    await Files.ensureDirectoryExists(dirname(to))
    await rename(from, to)
  },

  async size(path: string): Promise<number | null> {
    try {
      return (await stat(path)).size
    } catch {
      return null
    }
  },

  async lastModified(path: string): Promise<Date | null> {
    try {
      return (await stat(path)).mtime
    } catch {
      return null
    }
  },

  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  },

  async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  },

  /** Whether this process could write here — asked of the file, or its directory. */
  async isWritable(path: string): Promise<boolean> {
    const { access, constants } = await import('node:fs/promises')
    const target = (await Files.exists(path)) ? path : dirname(path)

    try {
      await access(target, constants.W_OK)

      return true
    } catch {
      return false
    }
  },

  async ensureDirectoryExists(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  },

  /** Empty it, keeping the directory itself — what a cache clear wants. */
  async cleanDirectory(path: string): Promise<void> {
    let entries: string[]

    try {
      entries = await readdir(path)
    } catch {
      return
    }

    for (const entry of entries) await rm(join(path, entry), { recursive: true, force: true })
  },

  async deleteDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true })
  },

  async copyDirectory(from: string, to: string): Promise<void> {
    await Files.ensureDirectoryExists(to)

    for (const entry of await readdir(from, { withFileTypes: true })) {
      const source = join(from, entry.name)
      const target = join(to, entry.name)

      if (entry.isDirectory()) await Files.copyDirectory(source, target)
      else await copyFile(source, target)
    }
  },

  /** Paths matching a pattern, relative to `directory`, sorted for a stable order. */
  async glob(pattern: string, directory: string): Promise<string[]> {
    const found: string[] = []

    for await (const entry of new Glob(pattern).scan({ cwd: directory, dot: false })) {
      found.push(entry)
    }

    return found.sort()
  },

  /** Every file under a directory, relative to it. */
  async allFiles(directory: string): Promise<string[]> {
    const found: string[] = []

    const walk = async (at: string): Promise<void> => {
      for (const entry of await readdir(at, { withFileTypes: true })) {
        const path = join(at, entry.name)

        if (entry.isDirectory()) await walk(path)
        else found.push(relative(directory, path))
      }
    }

    try {
      await walk(directory)
    } catch {
      return []
    }

    return found.sort()
  },

  async hash(path: string, algorithm = 'md5'): Promise<string | null> {
    const bytes = await Files.bytes(path)

    if (bytes === null) return null

    return createHash(algorithm).update(bytes).digest('hex')
  },

  /**
   * The extension a name claims, normalised.
   *
   * A claim about the name and not about the bytes — `@elvel/image`'s `probe()`
   * is what reads the file when that distinction matters.
   */
  guessExtension(path: string): string | undefined {
    const name = path.split(/[\\/]/).pop() ?? ''
    const dot = name.lastIndexOf('.')

    if (dot <= 0 || dot === name.length - 1) return undefined

    const extension = name.slice(dot + 1).toLowerCase()

    return ALIASES[extension] ?? extension
  },

  /**
   * Read a file nothing else may be writing.
   *
   * A shared read under an advisory lock is what upstream's `sharedGet` is, and
   * there is no portable advisory lock here — so this is a plain read, named the
   * same so a reader is not left looking for one. Two processes writing one file
   * need a real lock (`@elvel/cache`'s), not a hopeful read.
   */
  sharedGet(path: string): Promise<string | null> {
    return Files.get(path)
  }
}

/** Two spellings of one thing, so a caller can compare against one of them. */
const ALIASES: Record<string, string> = {
  jpeg: 'jpg',
  htm: 'html',
  yml: 'yaml',
  mjs: 'js',
  cjs: 'js'
}
