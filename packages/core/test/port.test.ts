import { afterEach, describe, expect, test } from 'bun:test'
import { Application } from '../src/application.ts'
import { PortInUseError, portInUse, portInUseMessage } from '../src/port.ts'

/**
 * Binding a port somebody else holds succeeds on Windows.
 *
 * `SO_REUSEADDR` permits a second bind to the same address, so two servers end up
 * listening and requests go to whichever socket wins. Measured: a second `serve`
 * printed `Server running on http://localhost:3000` while another process was
 * already there, and `netstat` showed both.
 *
 * What it costs is not a wasted process. It is a developer pressing Ctrl+C,
 * getting the prompt back, starting again, and watching the old server answer —
 * which reads as "this cannot be killed" and sends them looking anywhere but at
 * the port.
 */
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = []

/** A real listener, because the question is about a real socket. */
function occupy(port: number) {
  const server = Bun.serve({ port, fetch: () => new Response('taken') })

  servers.push(server)

  return server
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe('asking whether a port is taken', () => {
  test('a listening socket answers yes', async () => {
    occupy(3281)

    expect<boolean>(await portInUse(3281)).toBe(true)
  })

  test('and nothing answers no', async () => {
    expect<boolean>(await portInUse(3282)).toBe(false)
  })
})

describe('what the server does about it', () => {
  test('it refuses to start, rather than reporting success', async () => {
    occupy(3283)

    const app = new Application(process.cwd())

    app.config.set('app.env', 'testing')

    /**
     * The type matters as much as the throw.
     *
     * `serve` prints this one and exits 1; a boot failure it cannot do anything
     * about still goes out as a stack trace, and those must not look alike.
     */
    await expect(app.listen(3283)).rejects.toBeInstanceOf(PortInUseError)
  })

  test('and starts normally when the port is free', async () => {
    const app = new Application(process.cwd())

    app.config.set('app.env', 'testing')

    await app.listen(3284)

    expect<number | undefined>(app.router.server?.port).toBe(3284)

    app.router.server?.stop(true)
  })

  /**
   * The check is refusable, for the case it would be wrong about.
   *
   * A deliberate `reusePort` cluster has several processes on one port on purpose,
   * and a framework that cannot be told so is a framework that has to be worked
   * around.
   */
  test('`http.checkPort: false` binds anyway', async () => {
    occupy(3285)

    const app = new Application(process.cwd())

    app.config.set('app.env', 'testing')
    app.config.set('http.checkPort', false)

    // Windows allows the second bind; elsewhere Bun raises its own error. Either
    // way the framework got out of the way, which is what was asked of it.
    try {
      await app.listen(3285)
      app.router.server?.stop(true)
    } catch (error) {
      expect<boolean>(error instanceof PortInUseError).toBe(false)
    }
  })

  /**
   * The port this very process is already on is not somebody else's.
   *
   * `bun --hot` re-evaluates the module graph in place: the entry runs again,
   * builds a fresh application and binds the same port while the previous
   * server is still on it. Bun documents that as a handler swap rather than a
   * second socket — "reloads the fetch handler ... without restarting the
   * process" — but the probe cannot see the difference, and refusing here ended
   * `dev` on the first edit with a message naming the developer's own server.
   *
   * Asserted as "not the framework's refusal", the way the `checkPort: false`
   * case above is: the bind itself is the platform's business and differs
   * between them. What is being tested is that Elvel got out of the way.
   */
  test('a second bind from the same process is a reload, not a conflict', async () => {
    const first = new Application(process.cwd())

    first.config.set('app.env', 'testing')

    await first.listen(3286)

    const second = new Application(process.cwd())

    second.config.set('app.env', 'testing')

    try {
      await second.listen(3286)
      second.router.server?.stop(true)
    } catch (error) {
      expect<boolean>(error instanceof PortInUseError).toBe(false)
    }

    first.router.server?.stop(true)
  })
})

describe('the message', () => {
  test('names the port and the command that finds the process', () => {
    const message = portInUseMessage(3000, '')

    expect<boolean>(message.includes('port 3000')).toBe(true)
    expect<boolean>(message.includes('3001')).toBe(true)
    expect<boolean>(message.includes('http.checkPort')).toBe(true)

    /**
     * The incantation is per platform, and the person who needs it is the one
     * whose terminal is already confusing them — so it is not left to memory.
     */
    expect<boolean>(
      process.platform === 'win32' ? message.includes('taskkill') : message.includes('lsof')
    ).toBe(true)
  })

  test('and names the host when one was asked for', () => {
    expect<boolean>(portInUseMessage(8080, '127.0.0.1').includes('127.0.0.1:8080')).toBe(true)
  })
})
