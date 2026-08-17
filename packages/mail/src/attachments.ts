import { app } from '@elvel/core'
import type { Attachment } from './mailable.ts'

/** The slice of a storage disk an attachment needs. */
type ReadableDisk = {
  bytes(path: string): Promise<Uint8Array | null>
  mimeType(path: string): Promise<string | null>
}

type StorageFactory = { disk(name?: string): ReadableDisk }

export type DiskAttachmentOptions = {
  /** The name the recipient sees. Defaults to the file's own. */
  as?: string
  /** Defaults to whatever the disk reports. */
  contentType?: string
  /** Set to embed the file in the HTML with `cid:<id>`. */
  cid?: string
}

/**
 * Attach a file that lives on a storage disk — `Attachment::fromStorageDisk`.
 *
 * The bytes are read **now** rather than passed as a path, and that is the whole
 * point: a path only works for a disk that has one, so a queued message would
 * fail on S3, and a local path handed to a worker on another machine is a file
 * that is not there. Reading here means the attachment travels with the message.
 *
 * The disk's own `mimeType` is used unless told otherwise. A wrong content type
 * is how a PDF arrives as `application/octet-stream` and a mail client offers to
 * download it instead of showing it.
 */
export async function attachFromDisk(
  disk: string | undefined,
  path: string,
  options: DiskAttachmentOptions = {}
): Promise<Attachment> {
  const application = app()

  if (!application.bound('storage')) {
    throw new Error(
      'Attaching from a disk needs StorageServiceProvider. Register it in config/app.ts.'
    )
  }

  const storage = application.make('storage' as never) as unknown as StorageFactory
  const target = storage.disk(disk)
  const bytes = await target.bytes(path)

  if (bytes === null) {
    // Named in full, because the usual cause is a path relative to the wrong
    // disk and the message would otherwise go out silently missing its invoice.
    throw new Error(`Cannot attach [${path}]: it is not on the ${disk ?? 'default'} disk.`)
  }

  const contentType = options.contentType ?? (await target.mimeType(path)) ?? undefined

  return {
    filename: options.as ?? basename(path),
    content: bytes,
    ...(contentType === undefined ? {} : { contentType }),
    ...(options.cid === undefined ? {} : { cid: options.cid })
  }
}

/** The last segment of a disk path. Disk paths are `/`-separated everywhere. */
function basename(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '')

  return segments[segments.length - 1] ?? path
}
