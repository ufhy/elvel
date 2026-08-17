import { signRequest } from '@elyvel/support'
import { S3Client } from 'bun'
import { type CloudDisk, MissingFileError, type Visibility, type Writable, type WriteOptions } from '../contracts.ts'
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

  /**
   * S3 has no directories, so this asks whether anything lives under the prefix.
   *
   * The honest answer for object storage: `photos/` exists exactly when an object
   * whose key starts with it does. Reporting false because no directory *object*
   * exists would be true to S3 and useless to a caller.
   */
  async directoryExists(path: string): Promise<boolean> {
    return (await this.files(path)).length > 0 || (await this.directories(path)).length > 0
  }

  async checksum(path: string, algorithm = 'md5'): Promise<string> {
    const bytes = await this.bytesOrFail(path)

    return new Bun.CryptoHasher(algorithm as never).update(bytes).digest('hex')
  }

  async makeDirectory(): Promise<boolean> {
    return true
  }

  async deleteDirectory(path: string): Promise<boolean> {
    const keys = await this.allFiles(path)
    if (keys.length === 0) return true

    return this.delete(keys)
  }

  /**
   * The object's real ACL, read from the bucket.
   *
   * An object is public when its ACL grants `READ` to the `AllUsers` group, which
   * is exactly how Flysystem decides it. Anything else — including a grant to an
   * authenticated-users group — is private, because "anyone with the link" is the
   * only question this answers.
   *
   * A bucket that refuses `GetObjectAcl` falls back to the disk's default rather
   * than throwing. Many buckets are configured with ACLs disabled entirely
   * (`BucketOwnerEnforced`), and on one of those the permission is not merely
   * missing — the concept is. Failing here would make a `files()` listing that
   * reports visibility unusable on the most common modern setup.
   */
  async getVisibility(path: string): Promise<Visibility> {
    const response = await this.acl('GET', path)

    if (!response?.ok) return this.options.visibility ?? 'private'

    return grantsPublicRead(await response.text()) ? 'public' : 'private'
  }

  /**
   * Change the ACL in place — `PutObjectAcl`.
   *
   * The sub-resource request rather than a rewrite: rewriting means downloading
   * and re-uploading the whole object to change one flag, which on a large file
   * is minutes of transfer and a new version in a versioned bucket.
   *
   * Where the ACL sub-resource is not implemented or not permitted, the rewrite
   * is still the fallback — it is slower but it works, and a `setVisibility` that
   * silently did nothing would be worse than either.
   */
  async setVisibility(path: string, visibility: Visibility): Promise<boolean> {
    const response = await this.acl('PUT', path, {
      'x-amz-acl': visibility === 'public' ? 'public-read' : 'private'
    })

    if (response?.ok) return true

    const bytes = await this.bytes(path)
    if (!bytes) return false

    return this.put(path, bytes, { visibility })
  }

  /**
   * A signed request to the `?acl` sub-resource.
   *
   * Signed here rather than through Bun's client, which covers object operations
   * but does not expose sub-resources. Returns undefined when there are no
   * credentials to sign with, so a disk configured for a public bucket degrades
   * to its default instead of throwing.
   */
  private async acl(
    method: 'GET' | 'PUT',
    path: string,
    headers: Record<string, string> = {}
  ): Promise<Response | undefined> {
    const accessKeyId = this.options.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = this.options.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY

    if (!accessKeyId || !secretAccessKey) return undefined

    const url = `${this.objectUrl(path)}?acl`

    try {
      return await fetch(url, {
        method,
        headers: signRequest(
          {
            method,
            url,
            headers,
            region: this.options.region ?? 'us-east-1',
            service: 's3',
            now: new Date()
          },
          {
            accessKeyId,
            secretAccessKey,
            sessionToken: this.options.sessionToken ?? process.env.AWS_SESSION_TOKEN
          }
        )
      })
    } catch {
      // A bucket that cannot be reached is not a visibility answer; the caller
      // gets the disk's default, and every other operation will report the
      // failure loudly enough on its own.
      return undefined
    }
  }

  /**
   * Where the object actually lives — never the CDN.
   *
   * `url()` can be pointed at a CDN, and a signed request to a CDN is a signature
   * over the wrong host.
   */
  private objectUrl(path: string): string {
    const key = this.key(path)
    const endpoint = this.options.endpoint?.replace(/\/$/, '')

    if (endpoint) return `${endpoint}/${this.options.bucket}/${key}`

    const region = this.options.region ?? 'us-east-1'

    return `https://${this.options.bucket}.s3.${region}.amazonaws.com/${key}`
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

/** The `AllUsers` group, which is what "public" means on an S3 ACL. */
const ALL_USERS = 'http://acs.amazonaws.com/groups/global/AllUsers'

/**
 * Does this ACL document grant read to everyone?
 *
 * Parsed with a regular expression rather than an XML parser: the document is
 * one shape, defined by AWS, and the question asked of it is a single boolean.
 * Each `<Grant>` is examined whole so a grantee in one grant cannot pair with a
 * permission from the next.
 */
export function grantsPublicRead(xml: string): boolean {
  for (const grant of xml.match(/<Grant>[\s\S]*?<\/Grant>/g) ?? []) {
    const uri = /<URI>([^<]*)<\/URI>/.exec(grant)?.[1]
    const permission = /<Permission>([^<]*)<\/Permission>/.exec(grant)?.[1]

    if (uri === ALL_USERS && permission === 'READ') return true
  }

  return false
}
