import { resolve } from 'node:path'

/** Where in the application something happened. */
export type CallerFrame = {
  file: string
  line: number
}

/**
 * Frames inside these never answer "who ran this query".
 *
 * `node_modules/` covers the framework as an application sees it, which is where
 * the frames between the application and here come from: a gate check reaches
 * this through `@elvel/auth` and `@elvel/events`, and reporting the dispatcher
 * as the place somebody authorised is worse than reporting nothing.
 */
const ALWAYS_IGNORED = ['node_modules/', '/bun:', 'node:internal']

/**
 * The framework's own source, wherever this copy of it is installed.
 *
 * `node_modules/` is not enough when the framework is the repository being
 * worked in: there its frames are `packages/events/src/…`, so every query on a
 * page reported the event dispatcher as its caller — the same file and line for
 * all thirty-five of them, which is the one field a query entry is read for.
 *
 * Resolved at runtime rather than matched by name, because a rule spelled
 * `packages/` would also hide an application's own packages in its monorepo.
 * From `<root>/packages/lens/src` that is `<root>/packages`; installed, it is
 * `node_modules/@elvel`, which the list above already covers.
 *
 * Only `src` is hidden. A frame in a package's `test` directory is the caller
 * asking, not the framework answering — which is what the watchers' own tests
 * assert against.
 */
const FRAMEWORK_SOURCE = resolve(import.meta.dir, '..', '..')

function insideFramework(file: string): boolean {
  const normalised = file.replaceAll('\\', '/')
  const root = FRAMEWORK_SOURCE.replaceAll('\\', '/')

  return normalised.startsWith(`${root}/`) && normalised.includes('/src/')
}

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
    if (insideFramework(frame.file)) continue

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
