import type { Disk, Visibility, Writable, WriteOptions } from '../contracts.ts'

export type ReadThroughOptions = {
  /** Seconds a cached copy stays good. 0 keeps it until something evicts it. */
  ttl?: number
  /** Bytes the cache may hold. 0 is unbounded. */
  maxBytes?: number
}

type Held = { at: number; size: number }

/**
 * A local disk in front of a remote one.
 *
 * An application serving user uploads from S3 pays the round trip on every
 * read, and the only alternative was writing the caching by hand around every
 * call. Reads come from the cache when it has them; writes go to the origin and
 * drop the cached copy, because a stale copy served from local disk is worse
 * than the latency it saved.
 *
 * The cache is a disk like any other, so `memory` in a test and `local` in
 * production is a configuration rather than a second implementation.
 */
export class ReadThroughDisk implements Disk {
  private readonly held = new Map<string, Held>()
  private bytesHeld = 0

  constructor(
    readonly name: string,
    private readonly origin: Disk,
    private readonly cache: Disk,
    private readonly options: ReadThroughOptions = {}
  ) {}

  // ------------------------------------------------------------------ reading

  async get(path: string): Promise<string | null> {
    const bytes = await this.bytes(path)

    return bytes === null ? null : new TextDecoder().decode(bytes)
  }

  async bytes(path: string): Promise<Uint8Array | null> {
    if (await this.cached(path)) return this.cache.bytes(path)

    const bytes = await this.origin.bytes(path)

    if (bytes !== null) await this.hold(path, bytes)

    return bytes
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
    if (await this.cached(path)) return this.cache.readStream(path)

    /**
     * Fetched whole rather than teed.
     *
     * Teeing a stream to the caller and to the cache means the slower branch
     * decides how fast the faster one goes, and an unread branch never finishes
     * at all. A file worth caching is one being read repeatedly, so paying for
     * it once is the right trade.
     */
    const bytes = await this.origin.bytes(path)

    if (bytes === null) return null

    await this.hold(path, bytes)

    return this.cache.readStream(path)
  }

  async readRange(
    path: string,
    start: number,
    end: number
  ): Promise<ReadableStream<Uint8Array> | null> {
    if (await this.cached(path)) return this.cache.readRange(path, start, end)

    return this.origin.readRange(path, start, end)
  }

  async getOrFail(path: string): Promise<string> {
    return this.origin.getOrFail(path)
  }

  async bytesOrFail(path: string): Promise<Uint8Array> {
    return this.origin.bytesOrFail(path)
  }

  async json<T = unknown>(path: string): Promise<T | null> {
    const contents = await this.get(path)

    if (contents === null) return null

    try {
      return JSON.parse(contents) as T
    } catch {
      return null
    }
  }

  exists(path: string): Promise<boolean> {
    return this.origin.exists(path)
  }

  missing(path: string): Promise<boolean> {
    return this.origin.missing(path)
  }

  size(path: string): Promise<number | null> {
    return this.origin.size(path)
  }

  lastModified(path: string): Promise<Date | null> {
    return this.origin.lastModified(path)
  }

  mimeType(path: string): Promise<string | null> {
    return this.origin.mimeType(path)
  }

  checksum(path: string, algorithm?: string): Promise<string> {
    return this.origin.checksum(path, algorithm)
  }

  url(path: string): string {
    return this.origin.url(path)
  }

  /**
   * Signed by the origin, because only the origin can sign for itself — and a
   * URL is the one read that never reaches this disk at all.
   */
  temporaryUrl(path: string, expiresIn: number, options?: { contentDisposition?: string }): string {
    const origin = this.origin as Disk & {
      temporaryUrl?(path: string, expiresIn: number, options?: unknown): string
    }

    if (origin.temporaryUrl === undefined) {
      throw new Error(`Disk [${this.origin.name}] cannot sign a temporary URL.`)
    }

    return origin.temporaryUrl(path, expiresIn, options)
  }

  files(directory?: string, recursive?: boolean): Promise<string[]> {
    return this.origin.files(directory, recursive)
  }

  allFiles(directory?: string): Promise<string[]> {
    return this.origin.allFiles(directory)
  }

  directories(directory?: string, recursive?: boolean): Promise<string[]> {
    return this.origin.directories(directory, recursive)
  }

  allDirectories(directory?: string): Promise<string[]> {
    return this.origin.allDirectories(directory)
  }

  directoryExists(path: string): Promise<boolean> {
    return this.origin.directoryExists(path)
  }

  getVisibility(path: string): Promise<Visibility> {
    return this.origin.getVisibility(path)
  }

  // ------------------------------------------------------------------ writing

  async put(path: string, contents: Writable, options?: WriteOptions): Promise<boolean> {
    await this.evict(path)

    return this.origin.put(path, contents, options)
  }

  async writeStream(
    path: string,
    contents: ReadableStream<Uint8Array>,
    options?: WriteOptions
  ): Promise<boolean> {
    await this.evict(path)

    return this.origin.writeStream(path, contents, options)
  }

  async putFile(directory: string, file: Blob | File, options?: WriteOptions): Promise<string> {
    return this.origin.putFile(directory, file, options)
  }

  async putFileAs(
    directory: string,
    file: Blob | File,
    name: string,
    options?: WriteOptions
  ): Promise<string> {
    return this.origin.putFileAs(directory, file, name, options)
  }

  async prepend(path: string, contents: string): Promise<boolean> {
    await this.evict(path)

    return this.origin.prepend(path, contents)
  }

  async append(path: string, contents: string): Promise<boolean> {
    await this.evict(path)

    return this.origin.append(path, contents)
  }

  async delete(paths: string | string[]): Promise<boolean> {
    for (const path of Array.isArray(paths) ? paths : [paths]) await this.evict(path)

    return this.origin.delete(paths)
  }

  async copy(from: string, to: string): Promise<boolean> {
    await this.evict(to)

    return this.origin.copy(from, to)
  }

  async move(from: string, to: string): Promise<boolean> {
    await this.evict(from)
    await this.evict(to)

    return this.origin.move(from, to)
  }

  async setVisibility(path: string, visibility: Visibility): Promise<boolean> {
    return this.origin.setVisibility(path, visibility)
  }

  makeDirectory(path: string): Promise<boolean> {
    return this.origin.makeDirectory(path)
  }

  deleteDirectory(path: string): Promise<boolean> {
    return this.origin.deleteDirectory(path)
  }

  path(path: string): string {
    return this.origin.path(path)
  }

  /** Drop everything held, without touching the origin. */
  async flushCache(): Promise<void> {
    for (const path of [...this.held.keys()]) await this.evict(path)
  }

  // ------------------------------------------------------------------ the hold

  private async cached(path: string): Promise<boolean> {
    const entry = this.held.get(path)

    if (entry === undefined) return false

    const ttl = this.options.ttl ?? 0

    if (ttl > 0 && Date.now() - entry.at > ttl * 1000) {
      await this.evict(path)

      return false
    }

    return this.cache.exists(path)
  }

  private async hold(path: string, bytes: Uint8Array): Promise<void> {
    const max = this.options.maxBytes ?? 0

    // A file larger than the whole budget is never cached: holding it would
    // evict everything else to serve one read.
    if (max > 0 && bytes.length > max) return

    await this.cache.put(path, bytes)

    this.held.set(path, { at: Date.now(), size: bytes.length })
    this.bytesHeld += bytes.length

    if (max <= 0) return

    // Oldest first, which is the order the map keeps them in.
    for (const [oldest] of this.held) {
      if (this.bytesHeld <= max) break
      if (oldest === path) continue

      await this.evict(oldest)
    }
  }

  private async evict(path: string): Promise<void> {
    const entry = this.held.get(path)

    if (entry === undefined) return

    this.held.delete(path)
    this.bytesHeld -= entry.size

    await this.cache.delete(path)
  }
}
