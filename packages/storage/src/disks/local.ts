import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { Glob } from 'bun'
import type { Disk, Visibility, Writable, WriteOptions } from '../contracts.ts'
import { guessContentType, normalisePath, randomFilename, withinRoot } from '../paths.ts'

export type LocalDiskOptions = {
  root: string
  /** Base URL files are served from. Without it, `url()` says so rather than guessing. */
  url?: string
  /** Mode for files written as `public` / `private`. */
  visibility?: Visibility
  permissions?: { publicFile?: number; privateFile?: number; directory?: number }
}

/**
 * Files on this machine — Laravel's `local` disk.
 *
 * Every path goes through `withinRoot`, which resolves it and then checks the
 * result is still inside the disk. That check is the whole reason a disk is not
 * just a directory prefix: a path from a request must not be able to read
 * `../../.env`.
 */
export class LocalDisk implements Disk {
  private readonly root: string
  private readonly modes: { publicFile: number; privateFile: number; directory: number }

  constructor(
    readonly name: string,
    private readonly options: LocalDiskOptions
  ) {
    this.root = options.root
    this.modes = {
      publicFile: options.permissions?.publicFile ?? 0o644,
      privateFile: options.permissions?.privateFile ?? 0o600,
      directory: options.permissions?.directory ?? 0o755
    }
  }

  path(path: string): string {
    return withinRoot(this.root, path)
  }

  async exists(path: string): Promise<boolean> {
    const target = this.path(path)

    try {
      await stat(target)

      return true
    } catch {
      return false
    }
  }

  async missing(path: string): Promise<boolean> {
    return !(await this.exists(path))
  }

  /**
   * Note the shape of every read below: the path is resolved *outside* the
   * `try`.
   *
   * A missing file reads as null, which is a convenience worth having — but a
   * path that leaves the disk must not be caught by the same `catch`, or a
   * hostile path quietly reads as "not there" instead of being reported.
   */
  async get(path: string): Promise<string | null> {
    const target = this.path(path)

    try {
      return await Bun.file(target).text()
    } catch {
      return null
    }
  }

  async bytes(path: string): Promise<Uint8Array | null> {
    const target = this.path(path)

    try {
      return new Uint8Array(await Bun.file(target).arrayBuffer())
    } catch {
      return null
    }
  }

  async json<T = unknown>(path: string): Promise<T | null> {
    const target = this.path(path)

    try {
      return (await Bun.file(target).json()) as T
    } catch {
      return null
    }
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
    const file = Bun.file(this.path(path))

    if (!(await file.exists())) return null

    return file.stream()
  }

  async put(path: string, contents: Writable, options: WriteOptions = {}): Promise<boolean> {
    const target = this.path(path)

    await mkdir(dirname(target), { recursive: true, mode: this.modes.directory })

    // `Bun.write` takes every shape a caller might have: text, bytes, a Blob from
    // an upload, or a stream.
    await Bun.write(target, contents as Parameters<typeof Bun.write>[1])

    await this.applyVisibility(target, options.visibility ?? this.options.visibility ?? 'private')

    return true
  }

  async putFile(directory: string, file: Blob | File, options: WriteOptions = {}): Promise<string> {
    const name = randomFilename('name' in file ? (file as File).name : undefined)

    return this.putFileAs(directory, file, name, options)
  }

  async putFileAs(
    directory: string,
    file: Blob | File,
    name: string,
    options: WriteOptions = {}
  ): Promise<string> {
    const path = posix.join(normalisePath(directory), name)

    await this.put(path, file, options)

    return path
  }

  async prepend(path: string, contents: string): Promise<boolean> {
    const existing = (await this.get(path)) ?? ''

    return this.put(path, contents + existing)
  }

  async append(path: string, contents: string): Promise<boolean> {
    const existing = (await this.get(path)) ?? ''

    return this.put(path, existing + contents)
  }

  async delete(paths: string | string[]): Promise<boolean> {
    let deleted = false

    for (const path of Array.isArray(paths) ? paths : [paths]) {
      const target = this.path(path)

      try {
        await rm(target)
        deleted = true
      } catch {
        // A path that was already gone is not a failure: the caller wanted it
        // absent, and it is.
      }
    }

    return deleted
  }

  async copy(from: string, to: string): Promise<boolean> {
    const source = Bun.file(this.path(from))
    if (!(await source.exists())) return false

    const target = this.path(to)
    await mkdir(dirname(target), { recursive: true, mode: this.modes.directory })
    await Bun.write(target, source)

    return true
  }

  async move(from: string, to: string): Promise<boolean> {
    const source = this.path(from)
    const target = this.path(to)

    try {
      await mkdir(dirname(target), { recursive: true, mode: this.modes.directory })
      await rename(source, target)

      return true
    } catch {
      return false
    }
  }

  async size(path: string): Promise<number | null> {
    const target = this.path(path)

    try {
      return (await stat(target)).size
    } catch {
      return null
    }
  }

  async lastModified(path: string): Promise<Date | null> {
    const target = this.path(path)

    try {
      return (await stat(target)).mtime
    } catch {
      return null
    }
  }

  async mimeType(path: string): Promise<string | null> {
    if (await this.missing(path)) return null

    // Bun reads the type from the extension; fall back to our own table so the
    // answer does not depend on which extensions Bun happens to know.
    const type = Bun.file(this.path(path)).type

    return type && type !== 'application/octet-stream'
      ? type
      : (guessContentType(path) ?? 'application/octet-stream')
  }

  async files(directory = '', recursive = false): Promise<string[]> {
    return this.scan(directory, recursive, true)
  }

  async allFiles(directory = ''): Promise<string[]> {
    return this.files(directory, true)
  }

  async directories(directory = '', recursive = false): Promise<string[]> {
    return this.scan(directory, recursive, false)
  }

  async allDirectories(directory = ''): Promise<string[]> {
    return this.directories(directory, true)
  }

  async makeDirectory(path: string): Promise<boolean> {
    await mkdir(this.path(path), { recursive: true, mode: this.modes.directory })

    return true
  }

  async deleteDirectory(path: string): Promise<boolean> {
    const target = this.path(path)

    try {
      await rm(target, { recursive: true, force: true })

      return true
    } catch {
      return false
    }
  }

  async getVisibility(path: string): Promise<Visibility> {
    const mode = (await stat(this.path(path))).mode & 0o777

    // Anything the world can read counts as public, which is the same test
    // Flysystem's local adapter makes.
    return (mode & 0o044) !== 0 ? 'public' : 'private'
  }

  async setVisibility(path: string, visibility: Visibility): Promise<boolean> {
    await this.applyVisibility(this.path(path), visibility)

    return true
  }

  /**
   * A URL for the file.
   *
   * Only meaningful when something actually serves the disk — hence the
   * configured base URL rather than a guess. Laravel defaults to `/storage/…`,
   * which is only right for the disk its `storage:link` command links.
   */
  url(path: string): string {
    const base = this.options.url

    if (!base) {
      throw new Error(
        `Disk [${this.name}] has no URL. Set \`url\` in its configuration, and serve its root — \`artisan storage:link\` does that for the public disk.`
      )
    }

    return `${base.replace(/\/$/, '')}/${normalisePath(path)}`
  }

  private async applyVisibility(absolute: string, visibility: Visibility): Promise<void> {
    await chmod(absolute, visibility === 'public' ? this.modes.publicFile : this.modes.privateFile)
  }

  /** List files or directories, relative to the disk root. */
  private async scan(directory: string, recursive: boolean, onlyFiles: boolean): Promise<string[]> {
    const relative = normalisePath(directory)
    const cwd = this.path(relative)

    try {
      if (!(await stat(cwd)).isDirectory()) return []
    } catch {
      return []
    }

    const pattern = recursive ? '**/*' : '*'
    const found: string[] = []

    for await (const entry of new Glob(pattern).scan({
      cwd,
      onlyFiles,
      dot: true,
      followSymlinks: false
    })) {
      // `onlyFiles: false` yields files as well, so directories are filtered by
      // asking the filesystem rather than by guessing from the name.
      if (!onlyFiles) {
        const isDirectory = await stat(join(cwd, entry))
          .then((entryStat) => entryStat.isDirectory())
          .catch(() => false)

        if (!isDirectory) continue
      }

      found.push(relative === '' ? entry : posix.join(relative, entry))
    }

    return found.sort()
  }
}
