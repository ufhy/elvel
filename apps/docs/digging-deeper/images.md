# Images

Two halves, because **Bun has no image API at all** — no `createImageBitmap`, no
`OffscreenCanvas`, nothing native. So reading an image needs nothing installed,
and transforming one needs a backend that is looked for rather than assumed.

## Reading needs no backend

```ts
import { probe, tryProbe } from '@elvel/image'

probe(bytes)
// { format: 'png', width: 1, height: 1, mimeType: 'image/png' }

probe(gifBytes)
// { format: 'gif', width: 10, height: 5, mimeType: 'image/gif' }
```

Pure TypeScript over the file's own header, for png, jpeg, gif, webp, bmp, tiff,
avif and heic. That covers the check most applications actually want, and it is
worth being blunt about why: **a file extension and a client's `content-type` are
claims**, and the header is the file.

```ts
tryProbe(notAnImage)   // undefined
probe(notAnImage)      // throws
```

```
The bytes are not an image this can read. Supported: png, jpeg, gif, webp, …
```

`tryProbe` for a validation path that wants a boolean; `probe` where the bytes
were supposed to be an image and something is wrong if they are not.

## Transforming needs one

```ts
// config/image.ts
driver: process.env.IMAGE_DRIVER ?? 'auto'   // auto | sharp | magick | convert | sips
```

`auto` looks for a backend at boot — `sharp` if the application installed it,
ImageMagick if the machine has it, `sips` on macOS — and says so honestly when
there is none.

```ts
import { image } from '@elvel/image'

const photo = image().fromBytes(bytes)
// or fromFile(path), fromBase64(string), fromResponse(response)

await photo
  .resize(800, 600)          // cover / contain / fit / scale / crop / rotate
  .grayscale()               // blur / sharpen / orient / flipHorizontally
  .quality(80)
  .toWebp()                  // toPng / toJpeg / toAvif / toHeic / toFormat
  .store('storage/app/public/photo.webp')
```

The transformations are **queued**, not applied as you call them — `toBytes()`,
`toDataUri()`, `toResponse()` and `store()` are what run them, in one pass
through the backend. `probe()` and `dimensions()` read the original without
touching it, and `pending()` lists what is still waiting to be done.

## Backends differ, and the driver says which

```ts
image().driver().supports('resize')     // true  — everywhere
image().driver().supports('blur')       // false on sips
image().driver().supports('greyscale')  // false on sips
image().driver().supports('sharpen')    // false on sips
image().driver().supports('crop')       // true  — everywhere
```

Measured on this machine, where `auto` chose `sips`. Detection runs **once** and
is remembered: it costs a process spawn per candidate, and the answer cannot
change while the process is alive. Only ImageMagick and `sharp`
can blur, sharpen or greyscale; `sips` cannot, and **`supports()` is how you ask
before queueing a step**.

A driver that cannot perform a queued step raises an error rather than skipping
it — a resize that silently did not blur is a bug you find in production, in a
thumbnail, months later.
