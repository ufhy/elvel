import { ErrorLogDriver, SlackDriver } from '../src/drivers/misc.ts'

describe('the errorlog and slack drivers', () => {
  test('errorlog writes one plain line per record to stderr', () => {
    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)

    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk))

      return true
    }) as typeof process.stderr.write

    try {
      new ErrorLogDriver().write({
        level: 'error',
        message: 'it broke',
        context: { id: 7 },
        channel: 'app',
        time: new Date('2026-08-13T00:00:00.000Z')
      })
    } finally {
      process.stderr.write = original
    }

    // One line, parseable: stderr is what a container runtime collects, and a
    // collector reads lines rather than colours.
    expect<number>(written.length).toBe(1)
    expect<boolean>(
      written[0]?.startsWith('[2026-08-13T00:00:00.000Z] app.ERROR: it broke') === true
    ).toBe(true)
    expect<boolean>(written[0]?.includes('{"id":7}') === true).toBe(true)
  })

  test('slack posts, and only at or above its level', async () => {
    const posts: Array<{ text: string }> = []

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        posts.push((await request.json()) as { text: string })

        return new Response('ok')
      }
    })

    try {
      const driver = new SlackDriver({ url: `http://127.0.0.1:${server.port}`, level: 'error' })

      driver.write({
        level: 'info',
        message: 'ignored',
        context: {},
        channel: 'app',
        time: new Date()
      })
      driver.write({
        level: 'error',
        message: 'noticed',
        context: {},
        channel: 'app',
        time: new Date()
      })
      driver.write({
        level: 'critical',
        message: 'worse',
        context: {},
        channel: 'app',
        time: new Date()
      })

      // Fire-and-forget: a logging call must not wait on Slack.
      await Bun.sleep(120)

      // A channel that receives every info is a channel everybody mutes.
      expect<number>(posts.length).toBe(2)
      expect<boolean>(posts[0]?.text.includes('*ERROR* [app] noticed') === true).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test('a delivery failure is reported, not thrown', async () => {
    const reported: unknown[] = []

    // Nothing is listening on this port; the fetch rejects.
    new SlackDriver({ url: 'http://127.0.0.1:1/', level: 'debug' }, (error) =>
      reported.push(error)
    ).write({ level: 'error', message: 'x', context: {}, channel: 'app', time: new Date() })

    await Bun.sleep(120)

    // An unhandled rejection here would take the process down with it.
    expect<number>(reported.length).toBe(1)
  })
})
