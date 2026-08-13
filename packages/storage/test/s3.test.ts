import { describe, expect, test } from 'bun:test'
import { S3Disk } from '../src/disks/s3.ts'

/**
 * The S3 disk against a real bucket.
 *
 * Presigning is asserted offline in `storage.test.ts` — it is pure signing, so a
 * server proves nothing there. What a server *does* prove is the part that talks:
 * that a write is readable back, that `list` pages, that `stat` reports what was
 * stored, and that a presigned URL actually authorises a fetch.
 *
 * Point it at anything S3-compatible and it runs; without one it skips with a note
 * rather than failing, the same way the database suites treat Postgres and MySQL.
 *
 * MinIO, for example — the bucket has to exist first, the client will not make it:
 *
 *   docker run -d --name elysian-minio -p 9000:9000 \
 *     -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
 *     minio/minio server /data
 *   curl -X PUT http://127.0.0.1:9000/elysian-test --aws-sigv4 aws:amz:us-east-1:s3 \
 *     --user minioadmin:minioadmin \
 *     -H "x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
 *
 *   TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
 *   TEST_S3_BUCKET=elysian-test \
 *   TEST_S3_KEY=minioadmin \
 *   TEST_S3_SECRET=minioadmin \
 *   bun test packages/storage
 */
const endpoint = process.env.TEST_S3_ENDPOINT
const bucket = process.env.TEST_S3_BUCKET ?? 'elysian-test'
const accessKeyId = process.env.TEST_S3_KEY
const secretAccessKey = process.env.TEST_S3_SECRET

const configured = Boolean(endpoint && accessKeyId && secretAccessKey)

const reachable = await (async () => {
  if (!configured) {
    console.log('  skipping the S3 round trip: set TEST_S3_ENDPOINT, TEST_S3_KEY, TEST_S3_SECRET')

    return false
  }

  const disk = new S3Disk('s3', {
    bucket,
    endpoint,
    accessKeyId,
    secretAccessKey,
    prefix: 'probe'
  })

  try {
    await disk.put('probe.txt', 'probe')
    await disk.delete('probe.txt')

    return true
  } catch (error) {
    console.log(
      `  skipping the S3 round trip: ${(error instanceof Error ? error.message : String(error)).slice(0, 90)}`
    )

    return false
  }
})()

describe.skipIf(!reachable)('S3, against a real bucket', () => {
  /** A prefix per run so two suites against one bucket never collide. */
  const disk = () =>
    new S3Disk('s3', {
      bucket,
      endpoint,
      accessKeyId,
      secretAccessKey,
      prefix: `run-${Date.now().toString(36)}`
    })

  test('a write is readable back, with its metadata', async () => {
    const s3 = disk()

    try {
      await s3.put('reports/q1.json', JSON.stringify({ total: 42 }), {
        contentType: 'application/json'
      })

      expect(await s3.exists('reports/q1.json')).toBe(true)
      expect(await s3.json<{ total: number }>('reports/q1.json')).toEqual({ total: 42 })
      // `{"total":42}` — twelve bytes, as the server reports them.
      expect(await s3.size('reports/q1.json')).toBe(12)
      expect(await s3.mimeType('reports/q1.json')).toContain('application/json')
      expect(await s3.lastModified('reports/q1.json')).toBeInstanceOf(Date)
    } finally {
      await s3.deleteDirectory('')
    }
  })

  test('listing splits keys into files and the prefixes above them', async () => {
    const s3 = disk()

    try {
      await s3.put('top.txt', '1')
      await s3.put('nested/inner.txt', '2')
      await s3.put('nested/deeper/deep.txt', '3')

      expect(await s3.files()).toEqual(['top.txt'])
      expect(await s3.allFiles()).toEqual([
        'nested/deeper/deep.txt',
        'nested/inner.txt',
        'top.txt'
      ])
      expect(await s3.directories()).toEqual(['nested'])
      expect(await s3.allDirectories()).toEqual(['nested', 'nested/deeper'])
    } finally {
      await s3.deleteDirectory('')
    }
  })

  test('copy and move behave as they do on a filesystem', async () => {
    const s3 = disk()

    try {
      await s3.put('a.txt', 'contents')

      expect(await s3.copy('a.txt', 'b/copy.txt')).toBe(true)
      expect(await s3.get('b/copy.txt')).toBe('contents')

      expect(await s3.move('a.txt', 'b/moved.txt')).toBe(true)
      expect(await s3.exists('a.txt')).toBe(false)
      expect(await s3.get('b/moved.txt')).toBe('contents')
    } finally {
      await s3.deleteDirectory('')
    }
  })

  test('a presigned URL really authorises a fetch, and expiry is enforced', async () => {
    const s3 = disk()

    try {
      await s3.put('private/secret.txt', 'for your eyes only')

      const signed = await fetch(s3.temporaryUrl('private/secret.txt', 60))
      expect(signed.status).toBe(200)
      expect(await signed.text()).toBe('for your eyes only')

      // The same key without a signature must not be readable.
      const unsigned = await fetch(s3.url('private/secret.txt'))
      expect(unsigned.status).toBeGreaterThanOrEqual(400)
    } finally {
      await s3.deleteDirectory('')
    }
  })

  test('a presigned upload URL lets a client PUT directly', async () => {
    const s3 = disk()

    try {
      const url = s3.temporaryUploadUrl('uploads/direct.txt', 60, { contentType: 'text/plain' })

      const uploaded = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: 'uploaded without passing through the app'
      })

      expect(uploaded.ok).toBe(true)
      // The bytes are in the bucket, and never went through this process.
      expect(await s3.get('uploads/direct.txt')).toBe('uploaded without passing through the app')
    } finally {
      await s3.deleteDirectory('')
    }
  })

  test('a stream reads a file without holding it in memory', async () => {
    const s3 = disk()

    try {
      // A megabyte is enough to be streamed in more than one chunk.
      const payload = 'x'.repeat(1024 * 1024)
      await s3.put('large.txt', payload)

      const stream = await s3.readStream('large.txt')
      expect(stream).not.toBeNull()

      let bytes = 0
      for await (const chunk of stream as ReadableStream<Uint8Array>) bytes += chunk.byteLength

      expect(bytes).toBe(payload.length)
    } finally {
      await s3.deleteDirectory('')
    }
  })
})

/**
 * Does this backend implement per-object ACLs at all?
 *
 * MinIO does not: `GET ?acl` answers with a canned owner-FULL_CONTROL document
 * whatever the object's canned ACL was, and `PUT ?acl` returns 200 and changes
 * nothing — its model is bucket policies. So a bucket being reachable is not
 * enough to run these; the probe writes a public object and asks whether the
 * bucket can say so. Without that, this suite would report a failure of the
 * server as a failure of the code.
 */
const objectAcls = await (async () => {
  if (!reachable) return false

  const probe = new S3Disk('s3', {
    bucket,
    endpoint,
    accessKeyId,
    secretAccessKey,
    prefix: 'acl-probe'
  })

  try {
    await probe.put('probe.txt', 'probe', { visibility: 'public' })

    const supported = (await probe.getVisibility('probe.txt')) === 'public'

    if (!supported) {
      console.log('  skipping per-object ACLs: this backend does not implement them (MinIO does not)')
    }

    return supported
  } finally {
    await probe.delete('probe.txt')
  }
})()

describe.skipIf(!objectAcls)('per-object visibility, read from the bucket', () => {
  const disk = (visibility: 'public' | 'private' = 'private') =>
    new S3Disk('s3', {
      bucket,
      endpoint,
      accessKeyId,
      secretAccessKey,
      visibility,
      prefix: `acl-${Date.now().toString(36)}`
    })

  test('a private write reads back as private', async () => {
    const s3 = disk()

    try {
      await s3.put('secret.txt', 'shh')

      expect<string>(await s3.getVisibility('secret.txt')).toBe('private')
    } finally {
      await s3.delete('secret.txt')
    }
  })

  test('a public write reads back as public', async () => {
    const s3 = disk()

    try {
      await s3.put('poster.txt', 'everyone', { visibility: 'public' })

      // The real ACL, not the disk's default — the disk here defaults to private.
      expect<string>(await s3.getVisibility('poster.txt')).toBe('public')
    } finally {
      await s3.delete('poster.txt')
    }
  })

  test('setVisibility changes it without rewriting the object', async () => {
    const s3 = disk()

    try {
      await s3.put('flip.txt', 'contents')

      expect<boolean>(await s3.setVisibility('flip.txt', 'public')).toBe(true)
      expect<string>(await s3.getVisibility('flip.txt')).toBe('public')

      expect<boolean>(await s3.setVisibility('flip.txt', 'private')).toBe(true)
      expect<string>(await s3.getVisibility('flip.txt')).toBe('private')

      // The bytes are untouched by an ACL change, which is the point of using
      // the sub-resource rather than re-uploading.
      expect<string | null>(await s3.get('flip.txt')).toBe('contents')
    } finally {
      await s3.delete('flip.txt')
    }
  })
})
