import { config } from '@elvel/core'

/**
 * One region of the application, and the shell it boots from.
 *
 * Laravel says this with routes — `Route::view('{path}', 'main')->middleware('auth')`
 * for the application and `Route::view('/auth/{path}', 'auth')->middleware('guest')`
 * for the screens in front of it. Two things are being declared there: which bundle
 * an address belongs to, and who is allowed to ask for it. This is that, as data.
 *
 * Why data rather than routes the application writes itself: one of these cannot be
 * a route at all. A `GET /*` for the root loses to the static file plugin in
 * development, where it resolves per request and claims the same pattern —
 * measured, `/dashboard` came back as a JSON 404. So the root area is answered by
 * the exception handler instead, and only a declaration can be read by both.
 */
export type Area = {
  /** Prefix this area owns. `/` is the application itself, and must be last. */
  path: string

  /** The Vite entry this area's shell loads. Defaults to `spa.entry`. */
  entry?: string

  /** Middleware names, resolved through the registry — `['auth']`, `['guest']`. */
  middleware?: string[]

  /** `<title>` for this area's shell. Defaults to `spa.title`. */
  title?: string
}

/**
 * Declared areas, longest prefix first.
 *
 * Sorted here rather than trusted from config, because the order is what makes
 * `/auth/login` reach the auth area instead of the root one, and an application
 * listing them the other way round would be silently wrong.
 */
export function areas(): Area[] {
  return [...config<Area[]>('spa.areas', [])].sort((a, b) => b.path.length - a.path.length)
}

/** The area an address belongs to, or nothing if none is declared. */
export function areaFor(pathname: string): Area | undefined {
  return areas().find((area) => within(pathname, area.path))
}

/** Areas that can be mounted as real routes: everything except the root. */
export function prefixedAreas(): Area[] {
  return areas().filter((area) => normalise(area.path) !== '')
}

/** `/auth` owns `/auth` and `/auth/login`, and does not own `/authors`. */
export function within(pathname: string, path: string): boolean {
  const prefix = normalise(path)

  if (prefix === '') return true

  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** `/auth/` and `/auth` are the same prefix; `/` is the empty one. */
export function normalise(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path

  return trimmed === '/' ? '' : trimmed
}
