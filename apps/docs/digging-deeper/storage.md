# File storage

One interface over the local filesystem, S3-compatible buckets and an in-memory
disk for tests.

```ts
import { disk } from '@elvel/storage'

await disk().put('reports/2026.txt', 'annual')
await disk().get('reports/2026.txt')       // 'annual'
await disk('s3').put('invoices/1.pdf', bytes)
```

`disk()` is the default from `config/filesystems.ts`; `disk('name')` picks one.

## A path is always relative to the disk

This is the part to read before anything else. A path that would leave the disk
is **refused**, not cleaned up:

```
disk().get('../../.env')     → PathOutsideDiskError
disk().get('/etc/passwd')    → PathOutsideDiskError
disk().get('a/../../b')      → PathOutsideDiskError

disk().exists('reports/../reports/2026.txt')  → true
```

Traversal that stays inside is fine — the last line is a normal path with a
redundant hop. What is refused is a path that ends up *outside*.

Refusing rather than normalising is deliberate. Stripping the `..` segments would
silently turn a hostile path into a valid one, and the caller never learns their
input was wrong. A path containing a NUL byte is refused too: it truncates a
filename in some syscalls, so it cannot be trusted to mean what it reads as.

## Reading and writing

```ts
await disk().put('a.txt', 'contents')
await disk().get('a.txt')          // string, or null
await disk().bytes('a.txt')        // Uint8Array, or null
await disk().getOrFail('a.txt')    // throws instead of returning null
await disk().readStream('a.txt')   // for something large
await disk().prepend('a.txt', 'top\n')
await disk().append('a.txt', '\nmore')
await disk().delete(['a.txt', 'b.txt'])
await disk().copy('a.txt', 'b.txt')
await disk().move('a.txt', 'c.txt')
```

Metadata and listing:

```ts
await disk().size('a.txt')          // 6
await disk().mimeType('a.txt')      // 'text/plain; charset=utf-8'
await disk().lastModified('a.txt')  // Date
await disk().checksum('a.txt')      // md5 by default; pass an algorithm for another
await disk().files('reports')       // ['reports/2026.txt']
await disk().allFiles()             // recursive
await disk().directories('reports')
await disk().makeDirectory('archive')
await disk().deleteDirectory('archive')
```

## Uploads

```ts
const path = await disk().putFile('uploads', file)
// 'uploads/136d439e367545f9b5bc5e8a3088eee0.png'
```

`putFile` gives the file a random name and keeps the extension, which is what you
want for anything a person uploaded — a client-supplied filename is a claim, and
two people called it `photo.png`. `putFileAs(directory, file, name)` is there for
when the name is yours to choose.

## Visibility

```ts
await disk().getVisibility('a.txt')            // 'private'
await disk().setVisibility('a.txt', 'public')
await disk().put('a.txt', contents, { visibility: 'public' })
```

The scaffolded `local` disk is **private**, so nothing under it is reachable
without a route that serves it. The `public` disk is the one meant to be served
directly, after:

```bash
bun elvel storage:link
```

What it does with what it finds there:

| at the link path | what happens |
| --- | --- |
| nothing | the link is created |
| a link already | reported, kept — `--force` replaces it |
| a real directory | refused, because those are somebody's files |
| something it cannot read | reported as that, and nothing is touched |

The last row is the one worth knowing about. Every `lstat` failure used to be read
as "nothing there", so the command went on to create the link and failed further
down with `EEXIST: file already exists, symlink …` — a message about the wrong
thing. It shows up on Windows, where a symlink committed to git and checked out
without symlink support answers `EACCES`; creating the link there needs a privilege
Windows does not grant by default.

::: warning Visibility on the local disk is a POSIX mode
`public` is `0o644` and `private` is `0o600`, read back off the mode. Windows has
no such mode — `chmod` there toggles one read-only bit — so a file written
`private` reads back `public`. The disk does not pretend otherwise, and its tests
skip rather than assert something weaker. S3 carries visibility in the object's
ACL and is unaffected.
:::

## URLs

```ts
disk().url('reports/2026.txt')
// http://localhost:3000/memory/reports/2026.txt
```

`url` is **configured, not guessed** — the framework has no way to know what
serves a directory.

For a bucket, a presigned URL is generated **without a network round trip**,
because presigning is pure SigV4 over the key and the clock:

```ts
disk('s3').temporaryUrl('invoices/2026.pdf', 900)
```

```
host:   s3.us-east-1.amazonaws.com
params: X-Amz-Algorithm, X-Amz-Credential, X-Amz-Date,
        X-Amz-Expires, X-Amz-Signature, X-Amz-SignedHeaders
```

`temporaryUploadUrl(path, seconds, { contentType })` does the same for a PUT, so
a browser can upload straight to the bucket without the bytes passing through the
application.

## Serving a file

```ts
import { fileResponse } from '@elvel/storage'

.get('/invoices/:id', async ({ params }) =>
  (await fileResponse(disk(), `invoices/${params.id}.pdf`, { disposition: 'attachment' }))
    ?? new Response('Not found', { status: 404 })
)
```

```
status 200
content-disposition: attachment; filename="laporan.pdf"; filename*=UTF-8''laporan.pdf
content-length: 9
content-type: application/pdf
```

It **streams** rather than reading the file into memory, so a large download does
not cost the process the size of the file.

`contentDisposition(disposition, filename)` is exported on its own. It writes the
filename twice — stripped to ASCII for old clients, and again as `filename*` in
UTF-8 (RFC 6266):

```
contentDisposition('attachment', 'laporan "tahunan".pdf')
→ attachment; filename="laporan tahunan.pdf"; filename*=UTF-8''laporan%20%22tahunan%22.pdf
```

Quotes and backslashes are **removed rather than escaped**, because a filename
that closes the quoted string early can inject a header parameter of its own.

## Disks

```ts
// config/filesystems.ts
default: env('FILESYSTEM_DISK', 'local'),

disks: {
  local:  { driver: 'local', root: storage_path('app/private'), visibility: 'private' },
  public: { driver: 'local', root: storage_path('app/public'), url: `${env('APP_URL')}/storage`, visibility: 'public' },
  memory: { driver: 'memory' },
  s3:     { driver: 's3', bucket: …, accessKeyId: …, secretAccessKey: …, region: …, endpoint: …, prefix: … }
}
```

The S3 disk runs on **Bun's own client** — no AWS SDK and no Flysystem, which is
also why presigning needs no network. `endpoint` points it at R2, MinIO or
Spaces; `prefix` confines it to part of a bucket.

The round trip is tested against MinIO on every push. AWS's own eventual
consistency and region behaviour are not covered, and the
[behaviours file](https://github.com/ufhy/elvel/blob/main/BEHAVIOURS.md) says so.

## Testing

```ts
const fake = storage().fake()          // swaps the default disk for memory
const s3 = storage().fake('s3')

await disk().put('a.txt', 'x')
await disk().exists('a.txt')           // true, and nothing touched the filesystem
```

The memory disk implements the same contract, including visibility and listing,
so a test exercises the code you will run rather than a narrower stand-in.
