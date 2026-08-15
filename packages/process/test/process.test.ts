import { describe, expect, test } from 'bun:test'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessFailedError, ProcessManager } from '../src/index.ts'

/**
 * Asking the process itself where it is, rather than asking a shell.
 *
 * `pwd` is a POSIX command that prints a POSIX path, so the directory tests
 * used to assert both the shell and the path spelling of one platform — on
 * Windows the same `pwd` prints `/d/a/elyvel`, which is nothing `path()` was
 * given and nothing `process.cwd()` returns. This runs without a shell and
 * prints the working directory the way the platform spells it.
 */
const WHERE = ['bun', '-e', 'process.stdout.write(process.cwd())']

/** Real commands throughout, except where a fake is the thing under test. */
const run = () => new ProcessManager()

describe('running a command', () => {
  test('an array is executed without a shell', async () => {
    const result = await run().run(['echo', 'hello world'])

    result.throw()
    expect(result.successful()).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('hello world\n')
    expect<string[]>(result.lines()).toEqual(['hello world'])
  })

  test('an array argument reaches the command intact', async () => {
    // No shell means no word splitting: this is one argument, spaces and all.
    const result = await run().run(['printf', '%s', 'a b; echo pwned'])

    expect(result.output).toBe('a b; echo pwned')
  })

  test('a string goes through a shell, so operators work', async () => {
    const result = await run().run('echo one && echo two')

    expect<string[]>(result.lines()).toEqual(['one', 'two'])
  })

  test('a failure carries its code and stderr', async () => {
    const result = await run().run('echo trouble >&2; exit 3')

    expect(result.failed()).toBe(true)
    expect(result.exitCode).toBe(3)
    expect(result.errorOutput.trim()).toBe('trouble')
    expect(result.seeInErrorOutput('trouble')).toBe(true)
  })

  test('throw() puts the output in the message', async () => {
    const result = await run().run('echo what went wrong >&2; exit 1')

    // Without this the reason is on the object and absent from the log.
    expect(() => result.throw()).toThrow(/what went wrong/)
    expect(() => result.throw()).toThrow(ProcessFailedError)
    expect(result.throwIf(false)).toBe(result)
  })

  test('reads json straight out of the output', async () => {
    const result = await run().run(['echo', '{"ok":true}'])

    expect(result.json<{ ok: boolean }>()).toEqual({ ok: true })
  })
})

describe('configuration', () => {
  test('runs in a given directory', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'elysian-process-')))
    const result = await run().path(directory).run(WHERE)

    expect(await realpath(result.output.trim())).toBe(directory)
  })

  test('adds to the environment without replacing it', async () => {
    const result = await run().env({ GREETING: 'hei' }).run('echo "$GREETING and $HOME"')

    expect(result.output.trim()).toStartWith('hei and /')
    // PATH survived, which is what merging rather than replacing buys.
    expect((await run().env({ GREETING: 'x' }).run('command -v sh')).successful()).toBe(true)
  })

  test('writes stdin and closes it', async () => {
    const result = await run().input('two\none\n').run(['sort'])

    expect<string[]>(result.lines()).toEqual(['one', 'two'])
  })

  test('an immutable builder does not leak between calls', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'elysian-process-')))
    const base = run()
    const elsewhere = base.path(directory)

    expect(await realpath((await elsewhere.run(WHERE)).output.trim())).toBe(directory)
    // The base never learned about the directory.
    expect((await base.run(WHERE)).output.trim()).toBe(process.cwd())
  })
})

describe('timeouts', () => {
  test('a slow command is killed, and says so', async () => {
    const result = await run().timeout(150).run('sleep 5')

    expect(result.timedOut).toBe(true)
    expect(result.failed()).toBe(true)
    expect(result.signal).toBe('SIGKILL')
    expect(() => result.throw()).toThrow(/timed out after 150ms/)
  })

  test('a command that finishes in time is not marked as timed out', async () => {
    const result = await run().timeout(5000).run(['echo', 'quick'])

    expect(result.timedOut).toBe(false)
    expect(result.successful()).toBe(true)
  })

  /**
   * The distinction the idle timeout exists for: this command runs far longer
   * than the idle window but never stops talking, so it must survive.
   */
  test('output keeps a long command alive', async () => {
    const result = await run()
      .idleTimeout(400)
      .run('for i in 1 2 3 4 5 6; do echo tick; sleep 0.1; done')

    expect(result.successful()).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.lines().length).toBe(6)
  })

  test('silence kills it', async () => {
    const result = await run().idleTimeout(200).run('echo starting; sleep 5')

    expect(result.timedOut).toBe(true)
    expect(result.output.trim()).toBe('starting')
    expect(() => result.throw()).toThrow(/timed out after 200ms/)
  })
})

describe('a running command', () => {
  test('streams output as it arrives', async () => {
    const chunks: string[] = []
    const result = await run()
      .onOutput((chunk) => chunks.push(chunk))
      .run('echo a; sleep 0.05; echo b')

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(result.output)
  })

  test('separates the two streams', async () => {
    const seen: Array<[string, string]> = []
    await run()
      .onOutput((chunk, stream) => seen.push([stream, chunk.trim()]))
      .run('echo out; echo err >&2')

    expect(seen).toContainEqual(['stdout', 'out'])
    expect(seen).toContainEqual(['stderr', 'err'])
  })

  test('waits for a line, then stops it', async () => {
    const invoked = run().start('echo listening; sleep 30')

    await invoked.waitUntil((output) => output.includes('listening'))
    expect(invoked.running()).toBe(true)

    const result = await invoked.stop(100)

    expect(result.timedOut).toBe(false)
    expect(invoked.running()).toBe(false)
  })

  test('waitUntil gives up when the command exits first', async () => {
    const invoked = run().start('echo nothing useful; exit 0')

    await expect(invoked.waitUntil((output) => output.includes('never'))).rejects.toThrow(
      /finished before the output matched/
    )
  })

  test('a chatty command does not deadlock on a full pipe', async () => {
    // 200k of output: far past the pipe buffer, so anything reading only at the
    // end would hang here rather than fail.
    const result = await run().run(
      'for i in $(seq 1 4000); do echo 0123456789012345678901234567890123456789012345678; done'
    )

    expect(result.lines().length).toBe(4000)
    expect(result.successful()).toBe(true)
  })

  test('wait() can be called twice', async () => {
    const invoked = run().start(['echo', 'once'])
    const [first, second] = await Promise.all([invoked.wait(), invoked.wait()])

    expect(first).toBe(second)
  })
})

describe('pools and pipes', () => {
  test('runs commands at once and keys the results as declared', async () => {
    const started = Date.now()
    const results = await run()
      .pool((pool) => {
        pool.add('sleep 0.3; echo slow', 'slow')
        pool.add(['echo', 'fast'], 'fast')
      })
      .run()

    // Concurrent, so the pair costs about as much as the slower one alone.
    expect(Date.now() - started).toBeLessThan(1200)
    expect(results.get('fast')?.output.trim()).toBe('fast')
    expect(results.get('slow')?.output.trim()).toBe('slow')
    expect(results.successful()).toBe(true)
    // Declaration order, not completion order.
    expect<string[]>(Object.keys(results.results)).toEqual(['slow', 'fast'])
  })

  test('one failure does not abandon the others', async () => {
    const results = await run().concurrently(['exit 1', ['echo', 'fine']])

    expect(results.successful()).toBe(false)
    expect(results.failed().length).toBe(1)
    // The sibling still ran to completion and its output is there.
    expect(results.get('1')?.output.trim()).toBe('fine')
    expect(() => results.throw()).toThrow(/Pool step \[0\] failed/)
  })

  test('a pipe feeds each output into the next input', async () => {
    const result = await run()
      .pipe((pipe) => {
        pipe.add(['printf', 'banana\\napple\\ncherry\\n'])
        pipe.add(['sort'])
        pipe.add(['head', '-1'])
      })
      .run()

    expect(result.output.trim()).toBe('apple')
  })

  test('a failing step stops the pipe and is what comes back', async () => {
    const result = await run()
      .pipe((pipe) => {
        pipe.add('echo hello')
        pipe.add('echo boom >&2; exit 2')
        pipe.add(['tr', 'a-z', 'A-Z'])
      })
      .run()

    // A shell pipeline would have reported the last command's success instead.
    expect(result.exitCode).toBe(2)
    expect(result.errorOutput.trim()).toBe('boom')
  })
})

describe('faking', () => {
  test('answers instead of spawning, and records what was asked', async () => {
    const manager = run().fake({ 'git *': { output: 'abc123\n' } })

    const result = await manager.run(['git', 'rev-parse', 'HEAD'])

    expect(result.output).toBe('abc123\n')
    expect(result.successful()).toBe(true)
    manager.assertRan('git rev-parse HEAD').assertRanTimes('git *', 1).assertNotRan('rm -rf /')
  })

  test('a wildcard does not match more than it says', async () => {
    const manager = run().fake({ git: 'root only' })

    // `git` alone is fake; `git status` is not covered by it.
    expect((await manager.run('git')).output).toBe('root only')
    expect((await manager.run(['git', 'status'])).output).not.toBe('root only')
  })

  test('a sequence answers differently each time, then repeats the last', async () => {
    const manager = run().sequence('check', [
      { exitCode: 1, errorOutput: 'not yet' },
      { output: 'ready' }
    ])

    expect((await manager.run('check')).failed()).toBe(true)
    expect((await manager.run('check')).output).toBe('ready')
    // Running dry repeats rather than falling through to a real spawn.
    expect((await manager.run('check')).output).toBe('ready')
  })

  test('a stray command is refused when asked', async () => {
    const manager = run().fake({ 'git *': 'ok' }).preventStrayProcesses()

    await expect(manager.run(['curl', 'https://example.com'])).rejects.toThrow(/no fake matched/)
  })

  test('without the guard a stray command really runs', async () => {
    const manager = run().fake({ 'git *': 'ok' })

    const result = await manager.run(['echo', 'real'])

    expect(result.output).toBe('real\n')
  })

  test('an assertion failure names what did run', async () => {
    const manager = run().fake({ '*': 'ok' })
    await manager.run(['echo', 'one'])

    expect(() => manager.assertRan('echo two')).toThrow(/Ran: \[echo one\]/)
    expect(() => manager.assertNothingRan()).toThrow(/\[echo one\]/)
    expect(() => manager.assertRanTimes('*', 5)).toThrow(/it ran 1/)
  })

  test('stopFaking clears the tape as well as the fakes', async () => {
    const manager = run().fake({ '*': 'ok' })
    await manager.run('anything')

    manager.stopFaking()

    expect(manager.isFaking).toBe(false)
    manager.assertNothingRan()
  })

  test('a fake still streams to an output handler', async () => {
    const chunks: string[] = []
    const manager = run().fake({ build: { output: 'compiling\n', errorOutput: 'warning\n' } })

    await manager.onOutput((chunk, stream) => chunks.push(`${stream}:${chunk.trim()}`)).run('build')

    expect<string[]>(chunks).toEqual(['stdout:compiling', 'stderr:warning'])
  })
})

describe('binary output', () => {
  /**
   * Output that is not text, which a string cannot hold.
   *
   * `output` is a JavaScript string — UTF-16 — so every invalid sequence in a
   * PNG or a tarball becomes U+FFFD on the way in, and the bytes are gone before
   * anybody can ask for them. PHP has no such problem, which is why Laravel needs
   * no equivalent: its strings are byte arrays.
   */
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe])

  test('the bytes survive exactly, where the string does not', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'elysian-binary-')), 'probe.png')
    await Bun.write(file, png)

    const result = await run().binary().run(['cat', file])

    expect<number[]>([...result.bytes]).toEqual([...png])

    // The same run's text is mangled, which is the point of the option: the two
    // are different questions and only one of them has an answer here.
    expect(new TextEncoder().encode(result.output).length).not.toBe(png.length)
  })

  test('stderr is kept as bytes too', async () => {
    const result = await run().binary().run(['sh', '-c', 'printf "\\377\\376" >&2'])

    expect<number[]>([...result.errorBytes]).toEqual([0xff, 0xfe])
  })

  test('without binary() nothing is kept, rather than a re-encoded guess', async () => {
    const result = await run().run(['echo', 'plain'])

    // Empty on purpose. Re-encoding the decoded string is the round trip that
    // destroyed the data, so answering with it would be answering with a lie.
    expect<number>(result.bytes.length).toBe(0)
    expect<string>(result.output).toBe('plain\n')
  })

  test('a chunked stream is joined in order', async () => {
    // Larger than a pipe buffer, so it arrives in several chunks and the joining
    // is what is under test rather than a single read.
    const result = await run().binary().run(['sh', '-c', 'head -c 200000 /dev/zero'])

    expect<number>(result.bytes.length).toBe(200_000)
    expect<boolean>(result.bytes.every((byte) => byte === 0)).toBe(true)
  })
})
