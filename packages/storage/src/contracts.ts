/** What can be written to a disk. */
export type Writable = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>

/** `public` files are readable by anyone who can reach them; `private` are not. */
export type Visibility = 'public' | 'private'

export type WriteOptions = {
  visibility?: Visibility
  /** Stored alongside the file where the driver supports it. */
  contentType?: string
}

/**
 * A place to keep files — Laravel's `Filesystem` contract.
 *
 * Every method takes a path relative to the disk's root. A path that tries to
 * leave the root is refused rather than resolved: without Flysystem between us
 * and the filesystem, that check is ours to make.
 */
/**
 * Thrown by the `orFail` reads, when a caller would rather not check.
 *
 * The plain reads answer `null` for a missing file, which is right for the
 * common case — a missing avatar is not an error. It is wrong for the other
 * one: reading a config or an import that *must* exist, where `null` flows on
 * and fails somewhere far away with no mention of the path.
 */
export class MissingFileError extends Error {
  constructor(
    readonly disk: string,
    readonly path: string
  ) {
    super(`File [${path}] does not exist on the ${disk} disk.`)
    this.name = 'MissingFileError'
  }
}

export interface Disk {
  readonly name: string

  /** The absolute path of a file, where the disk has one. */
  path(path: string): string

  exists(path: string): Promise<boolean>

  missing(path: string): Promise<boolean>

  /** Contents as text, or null when the file is not there. */
  get(path: string): Promise<string | null>

  /** Contents as bytes, or null when the file is not there. */
  bytes(path: string): Promise<Uint8Array | null>

  /** Contents as text, or `MissingFileError` when the file is not there. */
  getOrFail(path: string): Promise<string>

  /** Contents as bytes, or `MissingFileError` when the file is not there. */
  bytesOrFail(path: string): Promise<Uint8Array>

  /** Parsed JSON, or null when the file is missing or unparseable. */
  json<T = unknown>(path: string): Promise<T | null>

  /** A stream, for a file too large to hold in memory. */
  readStream(path: string): Promise<ReadableStream<Uint8Array> | null>

  put(path: string, contents: Writable, options?: WriteOptions): Promise<boolean>

  /** Write with a generated, unique name and return the path it was stored at. */
  putFile(directory: string, file: Blob | File, options?: WriteOptions): Promise<string>

  putFileAs(
    directory: string,
    file: Blob | File,
    name: string,
    options?: WriteOptions
  ): Promise<string>

  prepend(path: string, contents: string): Promise<boolean>

  append(path: string, contents: string): Promise<boolean>

  /** Delete one or many. Missing paths are not an error. */
  delete(paths: string | string[]): Promise<boolean>

  copy(from: string, to: string): Promise<boolean>

  move(from: string, to: string): Promise<boolean>

  /** Bytes, or null when the file is not there. */
  size(path: string): Promise<number | null>

  lastModified(path: string): Promise<Date | null>

  mimeType(path: string): Promise<string | null>

  files(directory?: string, recursive?: boolean): Promise<string[]>

  allFiles(directory?: string): Promise<string[]>

  directories(directory?: string, recursive?: boolean): Promise<string[]>

  allDirectories(directory?: string): Promise<string[]>

  /**
   * Create a directory, optionally with a visibility of its own.
   *
   * A private file inside a world-readable directory is still listed by anything
   * that can read the directory, so the two settings are separate questions and
   * this is where the second one is answered.
   */
  /** Does this directory exist? Not the same question as a file existing. */
  directoryExists(path: string): Promise<boolean>

  /**
   * A hash of the file's bytes — Laravel's `checksum`.
   *
   * For telling whether an upload is the same file as one already stored, or
   * whether a transfer arrived intact. `md5` by default because that is what S3
   * puts in its `ETag`; anything Bun's hasher knows may be named instead.
   */
  checksum(path: string, algorithm?: string): Promise<string>

  makeDirectory(path: string, visibility?: Visibility): Promise<boolean>

  deleteDirectory(path: string): Promise<boolean>

  getVisibility(path: string): Promise<Visibility>

  setVisibility(path: string, visibility: Visibility): Promise<boolean>

  /** A URL the file can be fetched from. Throws when the disk has no notion of one. */
  url(path: string): string
}

/** A disk that can hand out links which expire — Laravel's `Cloud` contract. */
export interface CloudDisk extends Disk {
  /** A link that stops working after `expiresIn` seconds. */
  temporaryUrl(path: string, expiresIn: number, options?: { contentDisposition?: string }): string

  /** A link a client can `PUT` to, so an upload never passes through us. */
  temporaryUploadUrl(path: string, expiresIn: number, options?: { contentType?: string }): string
}

export function isCloudDisk(disk: Disk): disk is CloudDisk {
  return typeof (disk as Partial<CloudDisk>).temporaryUrl === 'function'
}
