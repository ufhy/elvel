import { controller, NotFoundException } from '@elysian/core'
import { disk, download, fileResponse, isCloudDisk, PathOutsideDiskError } from '@elysian/storage'
import { t } from 'elysia'

/**
 * Generated with `bun run playground make:controller FileController`, then
 * extended.
 *
 * `?disk=memory` (or `local`, `public`, `s3`) picks a disk, so the same routes
 * exercise every driver. Asserted by `scripts/smoke.ts` and driven over the
 * network with `artisan serve` + curl.
 */
export default controller('file')
  /** A real multipart upload. Elysia hands the file over as a `File`. */
  .post(
    '/check/files',
    async ({ body, query, status }) => {
      const name = typeof query.disk === 'string' ? query.disk : undefined
      const target = disk(name)

      // `putFile` generates a name, so two uploads of the same photo cannot
      // overwrite each other.
      const path =
        body.keepName === 'yes'
          ? await target.putFileAs('uploads', body.file, body.file.name)
          : await target.putFile('uploads', body.file)

      return status(201, {
        path,
        size: await target.size(path),
        mimeType: await target.mimeType(path),
        visibility: await target.getVisibility(path)
      })
    },
    {
      body: t.Object({
        file: t.File(),
        keepName: t.Optional(t.String())
      })
    }
  )

  /** Stream a file back, inline or as a download. */
  .get('/check/files/*', async ({ params, query }) => {
    const path = (params as Record<string, string>)['*'] ?? ''
    const target = disk(typeof query.disk === 'string' ? query.disk : undefined)

    const response =
      query.download === 'yes'
        ? await download(target, path, typeof query.as === 'string' ? query.as : undefined)
        : await fileResponse(target, path)

    if (!response) throw new NotFoundException(`No file at [${path}].`)

    return response
  })

  /** What is on the disk, and what it says about itself. */
  .get('/check/storage/listing', async ({ query }) => {
    const target = disk(typeof query.disk === 'string' ? query.disk : undefined)

    return {
      files: await target.allFiles(),
      directories: await target.allDirectories()
    }
  })

  .delete('/check/storage/listing', async ({ query }) => {
    const target = disk(typeof query.disk === 'string' ? query.disk : undefined)

    await target.deleteDirectory('uploads')
    await target.delete(await target.allFiles())

    return { cleared: true }
  })

  /**
   * A link that expires, for a disk that can make one.
   *
   * Signed locally, so this costs no network call even though it names an object
   * in a bucket.
   */
  .get('/check/storage/temporary-url', async ({ query }) => {
    const target = disk(typeof query.disk === 'string' ? query.disk : 's3')

    if (!isCloudDisk(target)) {
      return { supported: false, reason: `Disk [${target.name}] cannot make links that expire.` }
    }

    const path = typeof query.path === 'string' ? query.path : 'invoices/7.pdf'

    return {
      supported: true,
      url: target.temporaryUrl(path, 900),
      uploadUrl: target.temporaryUploadUrl(path, 900, { contentType: 'application/pdf' })
    }
  })

  /**
   * The traversal guard, from the outside.
   *
   * A path is refused rather than resolved, so a request cannot read `../../.env`
   * by asking nicely.
   */
  .get('/check/storage/traversal', async ({ query, status }) => {
    const target = disk(typeof query.disk === 'string' ? query.disk : undefined)
    const path = typeof query.path === 'string' ? query.path : '../../.env'

    try {
      return { refused: false, contents: await target.get(path) }
    } catch (error) {
      if (error instanceof PathOutsideDiskError) {
        return status(422, { refused: true, message: error.message })
      }

      throw error
    }
  })
