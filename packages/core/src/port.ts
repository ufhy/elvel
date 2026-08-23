/**
 * Is something already listening there?
 *
 * Asked before the server binds, because on Windows binding a port somebody else
 * holds **succeeds**. `SO_REUSEADDR` there permits a second bind to the same
 * address, so two processes end up listening and incoming connections go to
 * whichever socket wins. Measured: a second `serve` printed
 * `Server running on http://localhost:3000` while another process was already on
 * 3000, and `netstat` showed both.
 *
 * What that costs is not a wasted process. It is a developer pressing Ctrl+C,
 * getting their prompt back, starting the server again, and watching the old one
 * answer — which reads as "the server cannot be killed" and sends them looking in
 * the wrong place. The port was never the thing that failed; nothing said it was
 * taken.
 *
 * A TCP connect rather than a request: it answers the only question being asked,
 * and sends nothing to whatever is on the other side.
 */
export async function portInUse(port: number, hostname = '127.0.0.1'): Promise<boolean> {
  /**
   * A deadline, because a boot must not hang on a diagnostic.
   *
   * A refused connection is immediate on a loopback address and a listening one
   * is too. Anything slower than this is a network stack behaving oddly, and the
   * safe answer there is "carry on and let the bind decide" — a false negative
   * costs the old confusing behaviour, while waiting costs every start.
   */
  const timeout = new Promise<'unknown'>((resolve) => setTimeout(() => resolve('unknown'), 300))

  const connect = (async (): Promise<'in-use' | 'free'> => {
    try {
      const socket = await Bun.connect({
        hostname,
        port,
        socket: { data() {}, open() {}, close() {}, error() {} }
      })

      socket.end()

      return 'in-use'
    } catch {
      // `ECONNREFUSED` is the answer this exists to get: nothing is there.
      return 'free'
    }
  })()

  return (await Promise.race([connect, timeout])) === 'in-use'
}

/**
 * Thrown rather than logged, so a caller can answer it its own way.
 *
 * `serve` prints the message and exits; a test or a supervisor may want to try
 * another port instead. A named class is what lets them tell this apart from a
 * boot failure they cannot do anything about.
 */
export class PortInUseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortInUseError'
  }
}

/**
 * What to say, and what to do about it.
 *
 * The port and the command to find the process, because "address already in use"
 * on its own leaves the developer to remember the incantation for their platform
 * — and the one who needs the message is the one whose terminal is already
 * confusing them.
 */
export function portInUseMessage(port: number, hostname: string): string {
  const where = hostname === '' ? `port ${port}` : `${hostname}:${port}`

  const find =
    process.platform === 'win32'
      ? `netstat -ano | findstr :${port}     then     taskkill /pid <pid> /t /f`
      : `lsof -i :${port}     then     kill <pid>`

  return [
    `Something is already listening on ${where}.`,
    '',
    `  Find it:  ${find}`,
    '',
    '  Or serve somewhere else:  --port=3001',
    '  This check can be turned off with `http.checkPort: false`.'
  ].join('\n')
}
