import { app } from '@elvel/core'

/** Enough of a disk for an upload; `@elvel/storage` satisfies it. */
type UploadDisk = {
  putFileAs(
    directory: string,
    file: Blob | File,
    name: string,
    options?: { visibility?: string }
  ): Promise<string>
}

/**
 * An uploaded file, and where it goes.
 *
 * Validation already handles the Web `File` well — `file`, `image`, `mimes`,
 * `dimensions` all read it. What was missing is everything after: an upload was
 * put on a disk by inventing a name at the call site, and a file stored under
 * its client-supplied name is a path traversal and an overwrite waiting to
 * happen. That is what `hashName()` is for, and why it is the default.
 */
export class UploadedFile {
  constructor(readonly file: File) {}

  /** From whatever a multipart body handed over, or nothing if it is not a file. */
  static from(value: unknown): UploadedFile | undefined {
    return value instanceof File ? new UploadedFile(value) : undefined
  }

  /**
   * The name the client sent, with every path segment removed.
   *
   * A browser sends a bare filename; anything else sent `../../etc/passwd`
   * deliberately. Kept for display, never for a path — `store()` does not use
   * it.
   */
  clientOriginalName(): string {
    const name = this.file.name ?? ''

    return name.split(/[\\/]/).pop() ?? ''
  }

  /** The extension the client's name claims, lowercased and without the dot. */
  clientExtension(): string {
    const name = this.clientOriginalName()
    const dot = name.lastIndexOf('.')

    if (dot <= 0 || dot === name.length - 1) return ''

    return name
      .slice(dot + 1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
  }

  /** The type the client claimed. A claim, not a fact — validate it. */
  clientMimeType(): string {
    return this.file.type ?? ''
  }

  size(): number {
    return this.file.size
  }

  /**
   * A name nothing about the client decides, keeping the extension.
   *
   * Random rather than a hash of the contents: a content hash means reading the
   * whole file to name it, and two users uploading the same image would share a
   * path — so deleting one account's avatar removes the other's.
   */
  hashName(directory?: string): string {
    const extension = this.clientExtension()
    const name = `${crypto.randomUUID().replaceAll('-', '')}${extension === '' ? '' : `.${extension}`}`

    return directory === undefined || directory === '' ? name : `${trim(directory)}/${name}`
  }

  /** Store it under a generated name, and answer with the path it went to. */
  store(directory = '', options: { disk?: string; visibility?: string } = {}): Promise<string> {
    return this.storeAs(directory, this.hashName(), options)
  }

  /**
   * Store it under a name you chose.
   *
   * The name is taken as given apart from path segments, which are refused: a
   * name reaching outside the directory it was handed is the hazard this whole
   * class exists for, and silently flattening it would hide the attempt.
   */
  async storeAs(
    directory: string,
    name: string,
    options: { disk?: string; visibility?: string } = {}
  ): Promise<string> {
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error(`[${name}] is not a filename. Pass the directory separately.`)
    }

    return this.disk(options.disk).putFileAs(
      trim(directory),
      this.file,
      name,
      options.visibility === undefined ? {} : { visibility: options.visibility }
    )
  }

  /** The same, readable by anybody who has the URL. */
  storePublicly(directory = '', options: { disk?: string } = {}): Promise<string> {
    return this.store(directory, { ...options, visibility: 'public' })
  }

  storePubliclyAs(
    directory: string,
    name: string,
    options: { disk?: string } = {}
  ): Promise<string> {
    return this.storeAs(directory, name, { ...options, visibility: 'public' })
  }

  bytes(): Promise<ArrayBuffer> {
    return this.file.arrayBuffer()
  }

  stream(): ReadableStream<Uint8Array> {
    return this.file.stream()
  }

  /**
   * The storage manager, asked for rather than imported.
   *
   * `@elvel/http` does not depend on `@elvel/storage`, and its absence is an
   * error naming what to register — an upload that silently went nowhere would
   * be worse than one that failed.
   */
  private disk(name?: string): UploadDisk {
    const container = app()

    if (!container.bound('storage')) {
      throw new Error(
        'Storing an upload needs a disk. Register StorageServiceProvider, or write the file yourself.'
      )
    }

    return (container.make('storage') as { disk(name?: string): UploadDisk }).disk(name)
  }
}

/** No leading or trailing slash, so joining is unambiguous. */
function trim(directory: string): string {
  return directory.replace(/^\/+|\/+$/g, '')
}
