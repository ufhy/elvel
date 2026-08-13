import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application } from '@elysian/core'
import type { Disk } from '../src/contracts.ts'
import { LocalDisk } from '../src/disks/local.ts'
import { MemoryDisk } from '../src/disks/memory.ts'
import { grantsPublicRead, S3Disk } from '../src/disks/s3.ts'
import { StorageManager } from '../src/manager.ts'
import { normalisePath, PathOutsideDiskError, withinRoot } from '../src/paths.ts'
import { contentDisposition, download, fileResponse } from '../src/response.ts'

/**
 * The local and memory disks are held to the same contract.
 *
 * A disk that behaves differently per driver is the same trap as a cache that
 * does: code written against the memory disk in tests has to keep working against
 * the local one in production.
 */
type Candidate = {
  name: string
  make: () => Promise<{ disk: Disk; dispose: () => Promise<void> }>
}

const candidates: Candidate[] = [
  {
    name: 'memory',
    make: async () => ({
      disk: new MemoryDisk('memory', { url: 'http://localhost/files' }),
      dispose: async () => undefined
    })
  },
  {
    name: 'local',
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'elysian-storage-'))

      return {
        disk: new LocalDisk('local', { root, url: 'http://localhost/files' }),
        dispose: () => rm(root, { recursive: true, force: true })
      }
    }
  }
]

for (const candidate of candidates) {
  describe(`disk: ${candidate.name}`, () => {
    let disk: Disk
    let dispose: () => Promise<void>

    beforeEach(async () => {
      const made = await candidate.make()
      disk = made.disk
      dispose = made.dispose
    })

    afterEach(async () => {
      await dispose()
    })

    test('a written file reads back', async () => {
      expect(await disk.put('notes/hello.txt', 'Hello')).toBe(true)

      expect(await disk.exists('notes/hello.txt')).toBe(true)
      expect(await disk.missing('notes/hello.txt')).toBe(false)
      expect(await disk.get('notes/hello.txt')).toBe('Hello')
    })

    test('a missing file is null, not an error', async () => {
      expect(await disk.get('nope.txt')).toBeNull()
      expect(await disk.bytes('nope.txt')).toBeNull()
      expect(await disk.json('nope.txt')).toBeNull()
      expect(await disk.size('nope.txt')).toBeNull()
      expect(await disk.lastModified('nope.txt')).toBeNull()
      expect(await disk.readStream('nope.txt')).toBeNull()
      expect(await disk.exists('nope.txt')).toBe(false)
    })

    test('bytes round-trip unchanged', async () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 255])

      await disk.put('binary.bin', bytes)

      expect([...((await disk.bytes('binary.bin')) ?? [])]).toEqual([...bytes])
    })

    test('json is parsed, and nonsense reads as null', async () => {
      await disk.put('config.json', JSON.stringify({ ok: true, list: [1, 2] }))
      expect(await disk.json<{ ok: boolean; list: number[] }>('config.json')).toEqual({
        ok: true,
        list: [1, 2]
      })

      await disk.put('broken.json', '{not json')
      expect(await disk.json('broken.json')).toBeNull()
    })

    test('a stream yields the contents', async () => {
      await disk.put('stream.txt', 'streamed')

      const stream = await disk.readStream('stream.txt')
      expect(stream).not.toBeNull()

      expect(await new Response(stream).text()).toBe('streamed')
    })

    test('size and lastModified describe the file', async () => {
      const before = Date.now()
      await disk.put('sized.txt', '12345')

      expect(await disk.size('sized.txt')).toBe(5)

      const modified = await disk.lastModified('sized.txt')
      expect(modified).toBeInstanceOf(Date)
      // Allow a second either side: a filesystem may store whole seconds.
      expect(modified!.getTime()).toBeGreaterThanOrEqual(before - 1000)
    })

    test('prepend and append keep what was there', async () => {
      await disk.put('log.txt', 'middle')
      await disk.prepend('log.txt', 'start-')
      await disk.append('log.txt', '-end')

      expect(await disk.get('log.txt')).toBe('start-middle-end')
    })

    test('prepend and append create a file that was not there', async () => {
      await disk.append('fresh.txt', 'first')

      expect(await disk.get('fresh.txt')).toBe('first')
    })

    test('copy leaves the original, move does not', async () => {
      await disk.put('a.txt', 'contents')

      expect(await disk.copy('a.txt', 'b/copy.txt')).toBe(true)
      expect(await disk.get('a.txt')).toBe('contents')
      expect(await disk.get('b/copy.txt')).toBe('contents')

      expect(await disk.move('a.txt', 'b/moved.txt')).toBe(true)
      expect(await disk.exists('a.txt')).toBe(false)
      expect(await disk.get('b/moved.txt')).toBe('contents')
    })

    test('copying something absent reports failure', async () => {
      expect(await disk.copy('nope.txt', 'anywhere.txt')).toBe(false)
    })

    test('delete takes one path or many, and a missing one is fine', async () => {
      await disk.put('one.txt', '1')
      await disk.put('two.txt', '2')

      expect(await disk.delete('one.txt')).toBe(true)
      expect(await disk.delete(['two.txt', 'never-existed.txt'])).toBe(true)
      // Nothing to do is not a failure, but nothing was deleted either.
      expect(await disk.delete('still-nothing.txt')).toBe(false)
    })

    test('putFile generates a unique name and keeps the extension', async () => {
      const file = new File(['image bytes'], 'holiday photo.png', { type: 'image/png' })

      const first = await disk.putFile('uploads', file)
      const second = await disk.putFile('uploads', file)

      expect(first).toMatch(/^uploads\/[0-9a-f]{32}\.png$/)
      // A generated name must not collide, or one upload overwrites another.
      expect(first).not.toBe(second)
      expect(await disk.get(first)).toBe('image bytes')
    })

    test('putFileAs uses the name it was given', async () => {
      const file = new File(['bytes'], 'ignored.txt', { type: 'text/plain' })

      expect(await disk.putFileAs('uploads', file, 'invoice.txt')).toBe('uploads/invoice.txt')
      expect(await disk.get('uploads/invoice.txt')).toBe('bytes')
    })

    test('files and directories list one level, or everything', async () => {
      await disk.put('top.txt', '1')
      await disk.put('nested/inner.txt', '2')
      await disk.put('nested/deeper/deep.txt', '3')

      expect(await disk.files()).toEqual(['top.txt'])
      expect(await disk.allFiles()).toEqual([
        'nested/deeper/deep.txt',
        'nested/inner.txt',
        'top.txt'
      ])

      expect(await disk.files('nested')).toEqual(['nested/inner.txt'])
      expect(await disk.directories()).toEqual(['nested'])
      expect(await disk.allDirectories()).toEqual(['nested', 'nested/deeper'])
    })

    test('listing something that is not a directory is empty, not an error', async () => {
      expect(await disk.files('nowhere')).toEqual([])
      expect(await disk.directories('nowhere')).toEqual([])
    })

    test('a directory can be made and deleted with what is in it', async () => {
      await disk.makeDirectory('reports')
      await disk.put('reports/q1.txt', 'q1')
      await disk.put('reports/q2.txt', 'q2')

      expect(await disk.deleteDirectory('reports')).toBe(true)
      expect(await disk.exists('reports/q1.txt')).toBe(false)
      expect(await disk.allFiles()).toEqual([])
    })

    test('visibility is remembered', async () => {
      await disk.put('private.txt', 'secret')
      expect(await disk.getVisibility('private.txt')).toBe('private')

      await disk.put('public.txt', 'open', { visibility: 'public' })
      expect(await disk.getVisibility('public.txt')).toBe('public')

      await disk.setVisibility('private.txt', 'public')
      expect(await disk.getVisibility('private.txt')).toBe('public')
    })

    test('mimeType is guessed from the extension', async () => {
      await disk.put('page.html', '<p>hi</p>')
      await disk.put('data.json', '{}')

      expect(await disk.mimeType('page.html')).toContain('text/html')
      expect(await disk.mimeType('data.json')).toContain('application/json')
      expect(await disk.mimeType('missing.html')).toBeNull()
    })

    test('url joins the configured base', async () => {
      expect(disk.url('avatars/1.png')).toBe('http://localhost/files/avatars/1.png')
    })

    // ---------------------------------------------------------------- safety

    test('a path that leaves the disk is refused', async () => {
      for (const hostile of ['../outside.txt', '../../etc/passwd', 'nested/../../escape.txt']) {
        expect(() => disk.path(hostile)).toThrow(PathOutsideDiskError)
        await expect(disk.put(hostile, 'nope')).rejects.toThrow(PathOutsideDiskError)
      }
    })

    test('an absolute path is refused', async () => {
      await expect(disk.put('/etc/passwd', 'nope')).rejects.toThrow(PathOutsideDiskError)
      await expect(disk.get('/etc/hosts')).rejects.toThrow(PathOutsideDiskError)
    })

    test('traversal that stays inside is allowed', async () => {
      // `a/../b.txt` resolves to `b.txt`, which is inside — refusing it would be
      // wrong, and silently rewriting the hostile cases would be worse.
      await disk.put('a/../b.txt', 'inside')

      expect(await disk.get('b.txt')).toBe('inside')
    })
  })
}

describe('paths', () => {
  test('a relative path is normalised, not rewritten', () => {
    expect(normalisePath('a/b.txt')).toBe('a/b.txt')
    expect(normalisePath('./a/b.txt')).toBe('a/b.txt')
    expect(normalisePath('a//b.txt')).toBe('a/b.txt')
    expect(normalisePath('a/./b.txt')).toBe('a/b.txt')
    expect(normalisePath('a/c/../b.txt')).toBe('a/b.txt')
    expect(normalisePath('')).toBe('')
  })

  test('anything that escapes is refused', () => {
    for (const hostile of ['../a', '..', '/abs', 'a/../../b', 'C:/windows']) {
      expect(() => normalisePath(hostile)).toThrow(PathOutsideDiskError)
    }
  })

  test('a NUL byte is refused, because it truncates a filename', () => {
    expect(() => normalisePath('safe.txt\0.png')).toThrow(PathOutsideDiskError)
  })

  test('withinRoot resolves against the root and checks the result', () => {
    expect(withinRoot('/srv/app', 'files/a.txt')).toBe('/srv/app/files/a.txt')
    expect(() => withinRoot('/srv/app', '../a.txt')).toThrow(PathOutsideDiskError)
  })
})

describe('LocalDisk specifics', () => {
  let root: string
  let disk: LocalDisk

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'elysian-storage-local-'))
    disk = new LocalDisk('local', { root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('path() is absolute and inside the root', () => {
    expect(disk.path('a/b.txt')).toBe(join(root, 'a/b.txt'))
  })

  test('visibility is a file mode', async () => {
    await disk.put('secret.txt', 'shh', { visibility: 'private' })

    const { mode } = await Bun.file(disk.path('secret.txt')).stat()
    expect(mode & 0o777).toBe(0o600)

    await disk.setVisibility('secret.txt', 'public')
    const after = await Bun.file(disk.path('secret.txt')).stat()
    expect(after.mode & 0o777).toBe(0o644)
  })

  test('a symlink pointing out of the disk is refused', async () => {
    // The path itself looks innocent; only resolving it shows where it goes. This
    // is why `withinRoot` resolves before comparing.
    const outside = await mkdtemp(join(tmpdir(), 'elysian-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'not yours')
    await symlink(outside, join(root, 'escape'))

    try {
      // The link is inside the root, so reading through it is allowed…
      expect(await disk.get('escape/secret.txt')).toBe('not yours')

      // …but a path that walks out through it is not.
      await expect(disk.get('escape/../../secret.txt')).rejects.toThrow(PathOutsideDiskError)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('url() without configuration says what to do', () => {
    expect(() => disk.url('a.png')).toThrow(/has no URL.*storage:link/s)
  })

  test('a directory that is missing lists as empty, one that is unreadable does not', async () => {
    // The distinction is deliberate. A directory nobody has written to yet is a
    // normal state and reads as empty; one that exists but cannot be read is a
    // misconfiguration, and reporting it as "empty" would hide it.
    expect(await disk.files('never-created')).toEqual([])

    await mkdir(join(root, 'locked'))
    await chmod(join(root, 'locked'), 0o000)

    try {
      await expect(disk.files('locked')).rejects.toThrow(/EACCES|permission/i)
    } finally {
      await chmod(join(root, 'locked'), 0o755)
    }
  })
})

describe('S3Disk', () => {
  /**
   * Presigning is the part worth testing without a server: it is pure SigV4 over
   * the key and the clock, so it can be asserted offline. The round trip needs a
   * bucket, and is covered by the dialect-style suite when one is reachable.
   */
  const disk = new S3Disk('s3', {
    bucket: 'my-bucket',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    region: 'eu-west-1'
  })

  test('a temporary URL is signed and expires', () => {
    const url = new URL(disk.temporaryUrl('invoices/7.pdf', 900))

    expect(url.origin).toBe('https://s3.eu-west-1.amazonaws.com')
    expect(url.pathname).toBe('/my-bucket/invoices/7.pdf')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
    expect(url.searchParams.get('X-Amz-Credential')).toContain('AKIAEXAMPLE')
  })

  test('an upload URL is signed for PUT', () => {
    const url = disk.temporaryUploadUrl('uploads/photo.png', 60)

    expect(url).toContain('X-Amz-Signature')
    // A GET signature would not authorise the upload it is meant for.
    expect(url).not.toBe(disk.temporaryUrl('uploads/photo.png', 60))
  })

  test('a prefix scopes the disk inside the bucket', () => {
    const scoped = new S3Disk('s3', {
      bucket: 'my-bucket',
      accessKeyId: 'k',
      secretAccessKey: 's',
      prefix: 'tenant-1'
    })

    expect(scoped.path('a.txt')).toBe('tenant-1/a.txt')
    expect(new URL(scoped.temporaryUrl('a.txt', 60)).pathname).toBe('/my-bucket/tenant-1/a.txt')
  })

  test('url() prefers the configured base, then the endpoint', () => {
    expect(disk.url('a.png')).toBe('https://my-bucket.s3.eu-west-1.amazonaws.com/a.png')

    const cdn = new S3Disk('s3', {
      bucket: 'my-bucket',
      accessKeyId: 'k',
      secretAccessKey: 's',
      url: 'https://cdn.example.com/'
    })
    expect(cdn.url('a.png')).toBe('https://cdn.example.com/a.png')

    const minio = new S3Disk('s3', {
      bucket: 'my-bucket',
      accessKeyId: 'k',
      secretAccessKey: 's',
      endpoint: 'http://127.0.0.1:9000'
    })
    expect(minio.url('a.png')).toBe('http://127.0.0.1:9000/my-bucket/a.png')
  })

  test('a path that leaves the disk is refused here too', () => {
    expect(() => disk.path('../other-bucket/secret')).toThrow(PathOutsideDiskError)
  })

  test('makeDirectory is a no-op, because a bucket has no directories', async () => {
    expect(await disk.makeDirectory()).toBe(true)
  })
})

describe('responses', () => {
  let disk: MemoryDisk

  beforeEach(async () => {
    disk = new MemoryDisk()
    await disk.put('reports/q1.pdf', 'pdf bytes', { contentType: 'application/pdf' })
  })

  test('a file response streams with its type and length', async () => {
    const response = (await fileResponse(disk, 'reports/q1.pdf')) as Response

    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-length')).toBe('9')
    expect(response.headers.get('content-disposition')).toContain('inline')
    expect(await response.text()).toBe('pdf bytes')
  })

  test('a download is an attachment with the name asked for', async () => {
    const response = (await download(disk, 'reports/q1.pdf', 'Quarter 1.pdf')) as Response

    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="Quarter 1.pdf"; filename*=UTF-8\'\'Quarter%201.pdf'
    )
  })

  test('a missing file is null, so the caller can 404 it', async () => {
    expect(await fileResponse(disk, 'nope.pdf')).toBeNull()
  })

  test('a hostile filename cannot inject a header or a parameter', () => {
    const header = contentDisposition('attachment', 'a"; x=1\r\nX-Evil: yes.txt')

    // No CR or LF survives, so the header cannot be split into two.
    expect(header).not.toContain('\r')
    expect(header).not.toContain('\n')

    // And the quoted string is closed exactly once, by us: everything the
    // attacker wrote stays inside those quotes, where a `;` is just a character.
    const quoted = header.slice(header.indexOf('"') + 1, header.indexOf('"', header.indexOf('"') + 1))
    expect(quoted).toBe('a; x=1X-Evil: yes.txt')
    expect(header.split('"').length - 1).toBe(2)
  })

  test('a non-ASCII name is carried in filename*', () => {
    const header = contentDisposition('attachment', 'ringkasan-笔记.pdf')

    // The plain parameter stays ASCII for old clients; the real name is encoded.
    expect(header).toContain('filename="ringkasan-__.pdf"')
    expect(header).toContain("filename*=UTF-8''ringkasan-%E7%AC%94%E8%AE%B0.pdf")
  })
})

describe('StorageManager', () => {
  let app: Application
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'elysian-storage-manager-'))

    app = new Application(process.cwd())
    app.config.set('filesystems.default', 'local')
    app.config.set('filesystems.disks', {
      local: { driver: 'local', root },
      public: { driver: 'local', root: join(root, 'public'), url: 'http://localhost/storage' },
      memory: { driver: 'memory' },
      s3: { driver: 's3', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('disks resolve by name and are memoised', () => {
    const manager = new StorageManager(app)

    expect(manager.disk()).toBe(manager.disk('local'))
    expect(manager.disk('public')).not.toBe(manager.disk('local'))
    expect(manager.disk('s3')).toBeInstanceOf(S3Disk)
  })

  test('an unconfigured disk says where to configure it', () => {
    expect(() => new StorageManager(app).disk('nope')).toThrow(
      /is not configured.*config\/filesystems/s
    )
  })

  test('an unsupported driver points at extend()', () => {
    app.config.set('filesystems.disks.weird', { driver: 'floppy' })

    expect(() => new StorageManager(app).disk('weird')).toThrow(/storage\(\)\.extend/)
  })

  test('extend registers a driver of your own', async () => {
    app.config.set('filesystems.disks.custom', { driver: 'custom' })

    const manager = new StorageManager(app)
    manager.extend('custom', (name) => new MemoryDisk(name))

    await manager.disk('custom').put('a.txt', 'from a custom driver')

    expect(await manager.disk('custom').get('a.txt')).toBe('from a custom driver')
  })

  test('fake() swaps a disk for one in memory', async () => {
    const manager = new StorageManager(app)
    const fake = manager.fake('public')

    await manager.disk('public').put('avatars/1.png', 'bytes')

    // Nothing reached the filesystem…
    expect(await Bun.file(join(root, 'public/avatars/1.png')).exists()).toBe(false)
    // …and the test can read what was written.
    expect(await fake.get('avatars/1.png')).toBe('bytes')
    expect(await fake.exists('avatars/1.png')).toBe(true)
  })

  test('restore() puts the real disk back', async () => {
    const manager = new StorageManager(app)

    manager.fake('public')
    manager.restore('public')

    await manager.disk('public').put('real.txt', 'on disk')

    expect(await Bun.file(join(root, 'public/real.txt')).text()).toBe('on disk')
  })
})

describe('reading an S3 ACL document', () => {
  const acl = (grants: string) =>
    `<?xml version="1.0"?><AccessControlPolicy><AccessControlList>${grants}</AccessControlList></AccessControlPolicy>`

  const owner =
    '<Grant><Grantee><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant>'
  const everyone =
    '<Grant><Grantee><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant>'

  test('a grant of READ to AllUsers is what public means', () => {
    expect<boolean>(grantsPublicRead(acl(owner + everyone))).toBe(true)
  })

  test('an owner-only ACL is private', () => {
    expect<boolean>(grantsPublicRead(acl(owner))).toBe(false)
  })

  test('AllUsers with only WRITE is not public read', () => {
    const writeOnly = everyone.replace('READ', 'WRITE')

    expect<boolean>(grantsPublicRead(acl(owner + writeOnly))).toBe(false)
  })

  test('the authenticated-users group is not everyone', () => {
    // "Anyone with the link" is the only question this answers, and a signed-in
    // AWS principal is not that.
    const authenticated = everyone.replace('AllUsers', 'AuthenticatedUsers')

    expect<boolean>(grantsPublicRead(acl(authenticated))).toBe(false)
  })

  test('a grantee cannot pair with the next grant’s permission', () => {
    // Each grant is examined whole; matching URI and Permission independently
    // would read this pair as public.
    const split =
      '<Grant><Grantee><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>WRITE</Permission></Grant>' +
      '<Grant><Grantee><ID>owner</ID></Grantee><Permission>READ</Permission></Grant>'

    expect<boolean>(grantsPublicRead(acl(split))).toBe(false)
  })

  test('an empty or unparseable document is private', () => {
    expect<boolean>(grantsPublicRead('')).toBe(false)
    expect<boolean>(grantsPublicRead('<AccessDenied/>')).toBe(false)
  })
})

describe('the ?acl request itself', () => {
  let server: ReturnType<typeof Bun.serve>
  let seen: { method: string; url: string; acl?: string; authorization?: string } | undefined
  let answer: Response | undefined

  beforeEach(() => {
    seen = undefined
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)

        if (url.search === '?acl') {
          seen = {
            method: request.method,
            url: request.url,
            ...(request.headers.get('x-amz-acl') === null
              ? {}
              : { acl: request.headers.get('x-amz-acl') as string }),
            ...(request.headers.get('authorization') === null
              ? {}
              : { authorization: request.headers.get('authorization') as string })
          }

          return answer ?? new Response('<AccessControlPolicy/>')
        }

        return new Response(null, { status: 404 })
      }
    })
  })

  afterEach(() => {
    server.stop(true)
    answer = undefined
  })

  const disk = (visibility: 'public' | 'private' = 'private') =>
    new S3Disk('s3', {
      bucket: 'bucket',
      endpoint: `http://127.0.0.1:${server.port}`,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      region: 'eu-west-1',
      visibility,
      // A CDN in front, to prove the signed request does not go there.
      url: 'https://cdn.example.com'
    })

  test('it is signed, and aimed at the object rather than the CDN', async () => {
    await disk().getVisibility('reports/q1.pdf')

    expect<string | undefined>(seen?.method).toBe('GET')
    expect<string | undefined>(seen?.url).toBe(
      `http://127.0.0.1:${server.port}/bucket/reports/q1.pdf?acl`
    )
    // A signature over the CDN's host authorises nothing at the bucket.
    expect<boolean>(seen?.authorization?.startsWith('AWS4-HMAC-SHA256 ') === true).toBe(true)
    expect<boolean>(seen?.authorization?.includes('/eu-west-1/s3/aws4_request') === true).toBe(true)
  })

  test('setVisibility sends the ACL as a header, not a new object', async () => {
    expect<boolean>(await disk().setVisibility('reports/q1.pdf', 'public')).toBe(true)

    expect<string | undefined>(seen?.method).toBe('PUT')
    // Re-uploading to change one flag is minutes of transfer on a large file.
    expect<string | undefined>(seen?.acl).toBe('public-read')
  })

  test('a bucket that refuses the ACL falls back to the default', async () => {
    answer = new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })

    // Buckets with ACLs disabled entirely are the common modern setup; throwing
    // there would make visibility unusable rather than merely unknown.
    expect<string>(await disk('public').getVisibility('reports/q1.pdf')).toBe('public')
    expect<string>(await disk('private').getVisibility('reports/q1.pdf')).toBe('private')
  })

  test('with no credentials there is nothing to sign, and no request', async () => {
    const anonymous = new S3Disk('s3', {
      bucket: 'bucket',
      endpoint: `http://127.0.0.1:${server.port}`,
      accessKeyId: '',
      secretAccessKey: '',
      visibility: 'public'
    })

    expect<string>(await anonymous.getVisibility('a.txt')).toBe('public')
    expect<typeof seen>(seen).toBeUndefined()
  })
})
