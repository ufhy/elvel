import { type Disk, MissingFileError, type Visibility, type Writable, type WriteOptions } from '../contracts.ts'
import { guessContentType, normalisePath, randomFilename } from '../paths.ts'

type Entry = { bytes: Uint8Array; visibility: Visibility; contentType?: string; modifiedAt: Date }

/** Whatever a caller wrote, as bytes. */
async function toBytes(contents: Writable): Promise<Uint8Array> {
  if (typeof contents === 'string') return new TextEncoder().encode(contents)
  if (contents instanceof Uint8Array) return contents
  if (contents instanceof ArrayBuffer) return new Uint8Array(contents)
  if (contents instanceof Blob) return new Uint8Array(await contents.arrayBuffer())

  return new Uint8Array(await new Response(contents).arrayBuffer())
}

/**
 * A disk in memory — the equivalent of Laravel's `Storage::fake()`.
 *
 * It is a full disk rather than a stub, so a test exercises the same code path a
 * request would and then reads the bytes back. Nothing touches the filesystem, so
 * there is nothing to clean up and nothing a parallel test can trip over.
 */
export class MemoryDisk implements Disk {
  private readonly entries = new Map<string, Entry>()
  private readonly madeDirectories = new Set<string>()

  constructor(
    readonly name = 'memory',
    private readonly options: { url?: string; visibility?: Visibility } = {}
  ) {}

  /** There is no filesystem path; the key is returned so logs stay readable. */
  path(path: string): string {
    return normalisePath(path)
  }

  async exists(path: string): Promise<boolean> {
    const key = normalisePath(path)

    return this.entries.has(key) || this.isDirectory(key)
  }

  async missing(path: string): Promise<boolean> {
    return !(await this.exists(path))
  }

  async get(path: string): Promise<string | null> {
    const entry = this.entries.get(normalisePath(path))

    return entry ? new TextDecoder().decode(entry.bytes) : null
  }

  async bytes(path: string): Promise<Uint8Array | null> {
    return this.entries.get(normalisePath(path))?.bytes ?? null
  }

  async json<T = unknown>(path: string): Promise<T | null> {
    // `get` validates the path, and a refused one throws through this method too.
    const text = await this.get(path)
    if (text === null) return null

    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
    const entry = this.entries.get(normalisePath(path))
    if (!entry) return null

    return new Response(entry.bytes as unknown as BodyInit).body
  }

  async put(path: string, contents: Writable, options: WriteOptions = {}): Promise<boolean> {
    this.entries.set(normalisePath(path), {
      bytes: await toBytes(contents),
      visibility: options.visibility ?? this.options.visibility ?? 'private',
      contentType: options.contentType,
      modifiedAt: new Date()
    })

    return true
  }

  async putFile(directory: string, file: Blob | File, options: WriteOptions = {}): Promise<string> {
    return this.putFileAs(
      directory,
      file,
      randomFilename('name' in file ? (file as File).name : undefined),
      options
    )
  }

  async putFileAs(
    directory: string,
    file: Blob | File,
    name: string,
    options: WriteOptions = {}
  ): Promise<string> {
    const path = [normalisePath(directory), name].filter(Boolean).join('/')

    await this.put(path, file, { contentType: file.type || undefined, ...options })

    return path
  }

  async prepend(path: string, contents: string): Promise<boolean> {
    return this.put(path, contents + ((await this.get(path)) ?? ''))
  }

  async append(path: string, contents: string): Promise<boolean> {
    return this.put(path, ((await this.get(path)) ?? '') + contents)
  }

  async delete(paths: string | string[]): Promise<boolean> {
    let deleted = false

    for (const path of Array.isArray(paths) ? paths : [paths]) {
      if (this.entries.delete(normalisePath(path))) deleted = true
    }

    return deleted
  }

  async copy(from: string, to: string): Promise<boolean> {
    const entry = this.entries.get(normalisePath(from))
    if (!entry) return false

    this.entries.set(normalisePath(to), { ...entry, modifiedAt: new Date() })

    return true
  }

  async move(from: string, to: string): Promise<boolean> {
    if (!(await this.copy(from, to))) return false

    await this.delete(from)

    return true
  }

  async size(path: string): Promise<number | null> {
    return this.entries.get(normalisePath(path))?.bytes.byteLength ?? null
  }

  async lastModified(path: string): Promise<Date | null> {
    return this.entries.get(normalisePath(path))?.modifiedAt ?? null
  }

  async mimeType(path: string): Promise<string | null> {
    const entry = this.entries.get(normalisePath(path))
    if (!entry) return null

    return entry.contentType ?? guessContentType(path) ?? 'application/octet-stream'
  }

  async files(directory = '', recursive = false): Promise<string[]> {
    const base = normalisePath(directory)

    return [...this.entries.keys()]
      .filter((key) => this.isUnder(key, base))
      .filter((key) => recursive || !this.relative(key, base).includes('/'))
      .sort()
  }

  async allFiles(directory = ''): Promise<string[]> {
    return this.files(directory, true)
  }

  async directories(directory = '', recursive = false): Promise<string[]> {
    const base = normalisePath(directory)
    const found = new Set<string>()

    const candidates = [...this.entries.keys(), ...this.madeDirectories]

    for (const key of candidates) {
      if (!this.isUnder(key, base)) continue

      const segments = this.relative(key, base).split('/')
      // The last segment is the file itself unless the entry is a directory.
      if (this.entries.has(key)) segments.pop()

      let walked = base

      for (const segment of segments) {
        if (segment === '') continue

        walked = walked === '' ? segment : `${walked}/${segment}`
        found.add(walked)

        if (!recursive) break
      }
    }

    return [...found].sort()
  }

  async allDirectories(directory = ''): Promise<string[]> {
    return this.directories(directory, true)
  }

  async getOrFail(path: string): Promise<string> {
    const contents = await this.get(path)

    if (contents === null) throw new MissingFileError(this.name, path)

    return contents
  }

  async bytesOrFail(path: string): Promise<Uint8Array> {
    const contents = await this.bytes(path)

    if (contents === null) throw new MissingFileError(this.name, path)

    return contents
  }

  async directoryExists(path: string): Promise<boolean> {
    const key = normalisePath(path)

    // A directory exists if it was made, or if anything lives under it: a store
    // with no directory entries still has directories in every sense that matters
    // to a caller listing them.
    return this.madeDirectories.has(key) || this.isDirectory(key)
  }

  async checksum(path: string, algorithm = 'md5'): Promise<string> {
    const bytes = await this.bytesOrFail(path)

    return new Bun.CryptoHasher(algorithm as never).update(bytes).digest('hex')
  }

  async makeDirectory(path: string, _visibility?: Visibility): Promise<boolean> {
    // A memory disk has no directories of its own — a path exists because a file
    // under it does — so there is nothing to create and nothing to chmod.

    this.madeDirectories.add(normalisePath(path))

    return true
  }

  async deleteDirectory(path: string): Promise<boolean> {
    const base = normalisePath(path)

    for (const key of [...this.entries.keys()]) {
      if (this.isUnder(key, base) && key !== base) this.entries.delete(key)
    }

    for (const directory of [...this.madeDirectories]) {
      if (this.isUnder(directory, base)) this.madeDirectories.delete(directory)
    }

    return true
  }

  async getVisibility(path: string): Promise<Visibility> {
    return this.entries.get(normalisePath(path))?.visibility ?? 'private'
  }

  async setVisibility(path: string, visibility: Visibility): Promise<boolean> {
    const entry = this.entries.get(normalisePath(path))
    if (!entry) return false

    entry.visibility = visibility

    return true
  }

  url(path: string): string {
    const base = this.options.url

    if (!base) {
      throw new Error(`Disk [${this.name}] has no URL. Set \`url\` in its configuration.`)
    }

    return `${base.replace(/\/$/, '')}/${normalisePath(path)}`
  }

  /** Throw everything away. */
  flush(): void {
    this.entries.clear()
    this.madeDirectories.clear()
  }

  private isDirectory(key: string): boolean {
    if (this.madeDirectories.has(key)) return true

    return [...this.entries.keys()].some((entry) => entry.startsWith(`${key}/`))
  }

  private isUnder(key: string, base: string): boolean {
    return base === '' || key === base || key.startsWith(`${base}/`)
  }

  private relative(key: string, base: string): string {
    return base === '' ? key : key.slice(base.length + 1)
  }
  // ----------------------------------------------------------- assertions

  /**
   * What a fake disk is for — Laravel's `Storage::fake()` assertions.
   *
   * They live on the memory disk rather than in the testing package because they
   * need the store, and because a fake nobody can assert against is only half a
   * fake: a test that stores a file and never checks it passes whether the code
   * stored anything or not.
   *
   * Thrown rather than returned, so a failing assertion reads as a failing test
   * in any runner.
   */
  assertExists(paths: string | string[]): this {
    for (const path of Array.isArray(paths) ? paths : [paths]) {
      if (!this.entries.has(normalisePath(path))) {
        throw new Error(`Expected [${path}] on the disk. Present: ${this.listing()}`)
      }
    }

    return this
  }

  assertMissing(paths: string | string[]): this {
    for (const path of Array.isArray(paths) ? paths : [paths]) {
      if (this.entries.has(normalisePath(path))) {
        throw new Error(`Expected [${path}] not to be on the disk, but it is.`)
      }
    }

    return this
  }

  /** The file is there *and* holds these bytes. */
  assertContents(path: string, expected: string | Uint8Array): this {
    this.assertExists(path)

    const entry = this.entries.get(normalisePath(path)) as Entry
    const actual = new TextDecoder().decode(entry.bytes)
    const wanted = typeof expected === 'string' ? expected : new TextDecoder().decode(expected)

    if (actual !== wanted) {
      throw new Error(`Expected [${path}] to contain ${JSON.stringify(wanted)}, saw ${JSON.stringify(actual)}`)
    }

    return this
  }

  /** How many files are under a directory — not how many the caller wrote. */
  assertCount(directory: string, count: number): this {
    const prefix = normalisePath(directory)
    const found = [...this.entries.keys()].filter(
      (key) => prefix === '' || key.startsWith(`${prefix}/`)
    )

    if (found.length !== count) {
      throw new Error(
        `Expected ${count} file(s) under [${directory}], saw ${found.length}: ${found.join(', ') || '(none)'}`
      )
    }

    return this
  }

  assertDirectoryEmpty(directory: string): this {
    return this.assertCount(directory, 0)
  }

  private listing(): string {
    const keys = [...this.entries.keys()]

    return keys.length === 0 ? '(nothing)' : keys.join(', ')
  }

}
