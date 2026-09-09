/** Where in the application something happened. */
export type CallerFrame = {
  file: string
  line: number
}

/** Frames inside these never answer "who ran this query". */
const ALWAYS_IGNORED = ['node_modules/', 'packages/lens/src/', '/bun:', 'node:internal']

/**
 * Walk a stack and return the first frame that belongs to the application.
 *
 * Without this a query entry says it came from the connection pool, which every
 * query does and which tells nobody anything. Telescope drops the entry
 * entirely when no such frame exists, and so does this — a query with no
 * application frame came from inside a package, and reporting it against the
 * package's own file would be worse than not reporting it.
 *
 * The stack is captured by the caller rather than here so this stays testable
 * with a fixed string.
 */
export function callerFrom(
  stack: string | undefined,
  ignore: string[] = []
): CallerFrame | undefined {
  if (stack === undefined) return undefined

  const ignored = [...ALWAYS_IGNORED, ...ignore]

  for (const line of stack.split('\n').slice(1)) {
    const frame = parseFrame(line)

    if (frame === undefined) continue
    if (ignored.some((path) => frame.file.includes(path))) continue

    return frame
  }

  return undefined
}

/**
 * Both shapes V8 emits: `at name (/path/file.ts:12:5)` and `at /path/file.ts:12:5`.
 */
function parseFrame(line: string): CallerFrame | undefined {
  const match = /\(?((?:\/|[A-Za-z]:\\)[^()]*?):(\d+):\d+\)?\s*$/.exec(line.trim())

  if (match === null) return undefined

  const [, file, number] = match

  if (file === undefined || number === undefined) return undefined

  return { file, line: Number(number) }
}
