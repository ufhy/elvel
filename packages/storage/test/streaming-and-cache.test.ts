import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDisk } from '../src/disks/local.ts'
import { MemoryDisk } from '../src/disks/memory.ts'
import { ReadThroughDisk } from '../src/disks/read-through.ts'
import { fileResponse, parseRange } from '../src/response.ts'

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

describe('writeStream', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'elvel-stream-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('the local disk writes chunk by chunk', async () => {
    const disk = new LocalDisk('local', { root })

    await disk.writeStream('deep/video.txt', streamOf('one ', 'two ', 'three'))

    expect(await disk.get('deep/video.txt')).toBe('one two three')
  })

  /** A half-written file is worse than none: a reader cannot tell them apart. */
  test('and removes what it wrote when the stream fails', async () => {
    const disk = new LocalDisk('local', { root })

    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
        controller.error(new Error('upstream died'))
      }
    })

    await expect(disk.writeStream('broken.txt', failing)).rejects.toThrow('upstream died')
    expect(await disk.exists('broken.txt')).toBe(false)
  })

  test('the memory disk collects, so the fake exercises the same path', async () => {
    const disk = new MemoryDisk()

    await disk.writeStream('a.txt', streamOf('one ', 'two'))

    expect(await disk.get('a.txt')).toBe('one two')
  })
})

describe('readRange', () => {
  test('is inclusive at both ends, as a Range request is', async () => {
    const disk = new MemoryDisk()
    await disk.put('a.txt', '0123456789')

    const stream = await disk.readRange('a.txt', 2, 4)

    expect(await new Response(stream).text()).toBe('234')
  })
})

describe('parseRange', () => {
  test('a range from the start', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual([0, 99])
  })

  test('an open end runs to the last byte', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual([500, 999])
  })

  /** `bytes=-500` is the *last* 500 bytes, not "from the start to 500". */
  test('a suffix range counts from the end', () => {
    expect(parseRange('bytes=-500', 1000)).toEqual([500, 999])
  })

  test('an end past the file is clamped', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual([900, 999])
  })

  test('a start past the file is unsatisfiable', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=500-400', 1000)).toBe('unsatisfiable')
  })

  /** Served whole, which is allowed and is what every server does. */
  test('anything this does not understand is not a range', () => {
    expect(parseRange('bytes=0-10,20-30', 1000)).toBeUndefined()
    expect(parseRange('items=0-10', 1000)).toBeUndefined()
  })
})

describe('serving a range', () => {
  const disk = async () => {
    const memory = new MemoryDisk()
    await memory.put('video.bin', '0123456789')

    return memory
  }

  test('advertises Accept-Ranges even when nothing asked', async () => {
    const response = await fileResponse(await disk(), 'video.bin')

    expect(response?.headers.get('accept-ranges')).toBe('bytes')
    expect(response?.status).toBe(200)
  })

  test('answers 206 with the slice', async () => {
    const response = await fileResponse(await disk(), 'video.bin', {
      request: new Request('http://example.com/v', { headers: { range: 'bytes=2-4' } })
    })

    expect(response?.status).toBe(206)
    expect(response?.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(response?.headers.get('content-length')).toBe('3')
    expect(await response?.text()).toBe('234')
  })

  test('and 416 for one it cannot satisfy', async () => {
    const response = await fileResponse(await disk(), 'video.bin', {
      request: new Request('http://example.com/v', { headers: { range: 'bytes=99-' } })
    })

    expect(response?.status).toBe(416)
    expect(response?.headers.get('content-range')).toBe('bytes */10')
  })
})

describe('a read-through disk', () => {
  const build = async () => {
    const origin = new MemoryDisk('origin')
    const cache = new MemoryDisk('cache')
    let reads = 0

    const counted = new Proxy(origin, {
      get(target, key: string) {
        if (key === 'bytes') {
          return async (path: string) => {
            reads += 1

            return target.bytes(path)
          }
        }

        return Reflect.get(target, key) as unknown
      }
    })

    await origin.put('a.txt', 'from the origin')

    return {
      disk: new ReadThroughDisk('cached', counted as MemoryDisk, cache),
      cache,
      origin,
      reads: () => reads
    }
  }

  test('the round trip is paid once', async () => {
    const { disk, reads } = await build()

    expect(await disk.get('a.txt')).toBe('from the origin')
    expect(await disk.get('a.txt')).toBe('from the origin')
    expect(reads()).toBe(1)
  })

  test('and the second read comes from the cache', async () => {
    const { disk, cache } = await build()

    await disk.get('a.txt')

    expect(await cache.exists('a.txt')).toBe(true)
  })

  /** A stale copy served from local disk is worse than the latency it saved. */
  test('a write drops the cached copy', async () => {
    const { disk, cache, origin } = await build()

    await disk.get('a.txt')
    await disk.put('a.txt', 'changed')

    expect(await cache.exists('a.txt')).toBe(false)
    expect(await origin.get('a.txt')).toBe('changed')
    expect(await disk.get('a.txt')).toBe('changed')
  })

  test('so does a delete', async () => {
    const { disk, cache } = await build()

    await disk.get('a.txt')
    await disk.delete('a.txt')

    expect(await cache.exists('a.txt')).toBe(false)
  })

  test('a TTL expires it', async () => {
    const origin = new MemoryDisk('origin')
    const cache = new MemoryDisk('cache')
    await origin.put('a.txt', 'x')

    const disk = new ReadThroughDisk('cached', origin, cache, { ttl: 0.01 })

    await disk.get('a.txt')
    await Bun.sleep(20)
    await disk.get('a.txt')

    expect(await cache.exists('a.txt')).toBe(true)
  })

  /** Holding it would evict everything else to serve one read. */
  test('a file larger than the whole budget is never cached', async () => {
    const origin = new MemoryDisk('origin')
    const cache = new MemoryDisk('cache')
    await origin.put('big.txt', 'x'.repeat(100))

    const disk = new ReadThroughDisk('cached', origin, cache, { maxBytes: 10 })

    expect(await disk.get('big.txt')).toBe('x'.repeat(100))
    expect(await cache.exists('big.txt')).toBe(false)
  })

  test('and the budget evicts the oldest', async () => {
    const origin = new MemoryDisk('origin')
    const cache = new MemoryDisk('cache')

    await origin.put('one.txt', 'aaaa')
    await origin.put('two.txt', 'bbbb')

    const disk = new ReadThroughDisk('cached', origin, cache, { maxBytes: 6 })

    await disk.get('one.txt')
    await disk.get('two.txt')

    expect(await cache.exists('one.txt')).toBe(false)
    expect(await cache.exists('two.txt')).toBe(true)
  })
})
