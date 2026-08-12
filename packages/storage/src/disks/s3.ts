import { S3Client } from 'bun'
import type { CloudDisk, Visibility, Writable, WriteOptions } from '../contracts.ts'
import { guessContentType, normalisePath, randomFilename } from '../paths.ts'

export type S3DiskOptions = {
  bucket: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  region?: string
  /** For R2, MinIO, Spaces — anything S3-compatible. */
  endpoint?: string
  /** Prefix every key with this, so one bucket can hold several disks. */
  prefix?: string
  /** Base URL for `url()`, e.g. a CDN in front of the bucket. */
  url?: string
  /** Default ACL for writes. */
  visibility?: Visibility
}

/**
 * An S3-compatible bucket, on Bun's native client.
 *
 * No dependency and no AWS SDK: Bun signs requests itself, which is also why
 * `temporaryUrl` needs no network — presigning is pure SigV4 over the key and the
 * clock. Laravel reaches the same surface through Flysystem plus the AWS SDK.
 */
export class S3Disk implements CloudDisk {
  private readonly client: S3Client
  private readonly prefix: string

  constructor(
    readonly name: string,
    private readonly options: S3DiskOptions
  ) {
    this.prefix = options.prefix ? `${normalisePath(options.prefix)}/` : ''
    this.client = new S3Client({
      bucket: options.bucket,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      region: options.region,
      endpoint: options.endpoint
    })
  }

  /** The key a path maps to. There is no filesystem path on a bucket. */
  path(path: string): string {
    return this.key(path)
  }

  async exists(path: string): Promise<boolean> {
    return this.client.exists(this.key(path))
  }

  async missing(path: string): Promise<boolean> {
    return !(await this.exists(path))
  }

  async get(path: string): Promise<string | null> {
    try {
      return await this.client.file(this.key(path)).text()
    } catch {
      return null
    }
  }

  async bytes(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await this.client.file(this.key(path)).arrayBuffer())
    } catch {
      return null
    }
  }

  async json<T = unknown>(path: string): Promise<T | null> {
    try {
      return (await this.client.file(this.key(path)).json()) as T
    } catch {
      return null
    }
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
    try {
      if (!(await this.exists(path))) return null

      return this.client.file(this.key(path)).stream()
    } catch {
      return null
    }
  }

  async put(path: string, contents: Writable, options: WriteOptions = {}): Promise<boolean> {
    const visibility = options.visibility ?? this.options.visibility

    await this.client.write(this.key(path), contents as Parameters<S3Client['write']>[1], {
      type: options.contentType ?? guessContentType(path),
      // `public-read` is the only ACL that means anything here; anything else is
      // the bucket's own policy.
      acl: visibility === 'public' ? 'public-read' : undefined
    })

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
    const path = [normalisePath(directory), name].filter(Boolean).join('/')

    await this.put(path, file, { contentType: file.type || undefined, ...options })

    return path
  }

  async prepend(path: string, contents: string): Promise<boolean> {
    // No append on S3: a bucket object is replaced whole, so this reads and
    // rewrites rather than pretending to be cheap.
    return this.put(path, contents + ((await this.get(path)) ?? ''))
  }

  async append(path: string, contents: string): Promise<boolean> {
    return this.put(path, ((await this.get(path)) ?? '') + contents)
  }

  async delete(paths: string | string[]): Promise<boolean> {
    let deleted = false

    for (const path of Array.isArray(paths) ? paths : [paths]) {
      try {
        await this.client.delete(this.key(path))
        deleted = true
      } catch {
        // Already gone is the outcome the caller asked for.
      }
    }

    return deleted
  }

  async copy(from: string, to: string): Promise<boolean> {
    const source = await this.bytes(from)
    if (!source) return false

    return this.put(to, source, { contentType: (await this.mimeType(from)) ?? undefined })
  }

  async move(from: string, to: string): Promise<boolean> {
    if (!(await this.copy(from, to))) return false

    await this.delete(from)

    return true
  }

  async size(path: string): Promise<number | null> {
    try {
      return (await this.client.stat(this.key(path))).size
    } catch {
      return null
    }
  }

  async lastModified(path: string): Promise<Date | null> {
    try {
      return (await this.client.stat(this.key(path))).lastModified
    } catch {
      return null
    }
  }

  async mimeType(path: string): Promise<string | null> {
    try {
      return (await this.client.stat(this.key(path))).type ?? guessContentType(path) ?? null
    } catch {
      return null
    }
  }

  async files(directory = '', recursive = false): Promise<string[]> {
    const { files } = await this.listing(directory, recursive)

    return files
  }

  async allFiles(directory = ''): Promise<string[]> {
    return this.files(directory, true)
  }

  async directories(directory = '', recursive = false): Promise<string[]> {
    const { directories } = await this.listing(directory, recursive)

    return directories
  }

  async allDirectories(directory = ''): Promise<string[]> {
    return this.directories(directory, true)
  }

  /**
   * A bucket has no directories, only keys that share a prefix.
   *
   * Returning true rather than throwing keeps code that works on both kinds of
   * disk from having to know which it has.
   */
  async makeDirectory(): Promise<boolean> {
    return true
  }

  async deleteDirectory(path: string): Promise<boolean> {
    const keys = await this.allFiles(path)
    if (keys.length === 0) return true

    return this.delete(keys)
  }

  /**
   * S3 has no per-object visibility we can read back without extra permissions,
   * so this reports the disk's default rather than guessing per key.
   */
  async getVisibility(): Promise<Visibility> {
    return this.options.visibility ?? 'private'
  }

  async setVisibility(path: string, visibility: Visibility): Promise<boolean> {
    // Rewriting the object is the only way to change its ACL through this client.
    const bytes = await this.bytes(path)
    if (!bytes) return false

    return this.put(path, bytes, { visibility })
  }

  /**
   * A public URL.
   *
   * From the configured base when there is one — usually a CDN — otherwise built
   * from the endpoint, which only works for a bucket that is actually public.
   */
  url(path: string): string {
    const key = this.key(path)

    if (this.options.url) return `${this.options.url.replace(/\/$/, '')}/${key}`

    const endpoint = this.options.endpoint?.replace(/\/$/, '')

    if (endpoint) return `${endpoint}/${this.options.bucket}/${key}`

    const region = this.options.region ?? 'us-east-1'

    return `https://${this.options.bucket}.s3.${region}.amazonaws.com/${key}`
  }

  /**
   * A link that expires.
   *
   * Signed locally — no request is made — so this is cheap enough to call per row
   * when rendering a list.
   */
  temporaryUrl(
    path: string,
    expiresIn: number,
    options: { contentDisposition?: string } = {}
  ): string {
    return this.client.presign(this.key(path), {
      expiresIn,
      method: 'GET',
      ...(options.contentDisposition ? { contentDisposition: options.contentDisposition } : {})
    })
  }

  /**
   * A link a client can `PUT` to.
   *
   * The upload then goes straight to the bucket: bytes never pass through the
   * application, which is the point.
   */
  temporaryUploadUrl(
    path: string,
    expiresIn: number,
    options: { contentType?: string } = {}
  ): string {
    return this.client.presign(this.key(path), {
      expiresIn,
      method: 'PUT',
      type: options.contentType ?? guessContentType(path)
    })
  }

  /** The underlying client, for anything this disk does not wrap. */
  get s3(): S3Client {
    return this.client
  }

  private key(path: string): string {
    return this.prefix + normalisePath(path)
  }

  /**
   * One `list` call, split into files and the prefixes that stand in for
   * directories.
   */
  private async listing(
    directory: string,
    recursive: boolean
  ): Promise<{ files: string[]; directories: string[] }> {
    const base = normalisePath(directory)
    const prefix = this.prefix + (base === '' ? '' : `${base}/`)

    const files: string[] = []
    const directories = new Set<string>()

    let startAfter: string | undefined

    // `list` returns at most 1,000 keys, so a full listing has to page.
    while (true) {
      const page = await this.client.list({ prefix, maxKeys: 1000, startAfter })

      for (const entry of page.contents ?? []) {
        const relative = entry.key.slice(this.prefix.length)
        const within = base === '' ? relative : relative.slice(base.length + 1)

        if (!recursive && within.includes('/')) {
          // A key deeper than this level contributes its first segment as a
          // directory instead.
          directories.add(base === '' ? (within.split('/')[0] as string) : `${base}/${within.split('/')[0]}`)
          continue
        }

        if (recursive && within.includes('/')) {
          const segments = within.split('/')
          segments.pop()

          let walked = base
          for (const segment of segments) {
            walked = walked === '' ? segment : `${walked}/${segment}`
            directories.add(walked)
          }
        }

        files.push(relative)
      }

      if (!page.isTruncated) break

      startAfter = page.contents?.at(-1)?.key
      if (!startAfter) break
    }

    return { files: files.sort(), directories: [...directories].sort() }
  }
}
