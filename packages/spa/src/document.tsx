import { json, vite } from '@elvel/view'

export type DocumentProps = {
  /** The Vite entry, as the manifest names it. */
  entry: string

  /** Where the client mounts. */
  mountId: string

  title: string

  /**
   * Everything the client boots with, or `undefined` for a shell.
   *
   * Kept as one opaque value: it is a payload, and this page's job is to carry it
   * across unchanged rather than to know its shape.
   */
  payload?: unknown

  /** Rendered inside `<head>`, after the asset tags — a kit's meta, a favicon. */
  head?: string
}

/**
 * The one document a client-routed application boots from.
 *
 * Rendered for `/` and for every address the client router owns, which arrive as
 * 404s. One component, so a deep link and the front page cannot disagree about
 * what the application starts with.
 *
 * The asset tags come from `vite()` and nothing here writes a `<script>` of its
 * own. That is load-bearing: `vite()` is what points at the dev server while one
 * is running, at the manifest afterwards, and what carries whatever the other Vite
 * plugins injected — the React Fast Refresh preamble, Vue DevTools, a service
 * worker registration. A document that assembled its own tags would silently drop
 * all of it.
 */
export function Document({ entry, mountId, title, payload, head }: DocumentProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {title === '' ? '' : <title safe>{title}</title>}
        {vite([entry])}
        {head ?? ''}
      </head>
      <body>
        {/*
          The data travels as data, in an inert `<script type="application/json">`,
          never as an assignment to `window`. The browser does not execute this
          element, so nothing inside a customer's name can redefine anything on the
          page. Inertia and Nuxt both arrived at the same shape.

          `json()` does the escaping, and it is not the escaping HTML needs: inside
          a script the parser hunts for the literal `</script`, so a value
          containing one would end the element early and everything after it would
          be markup again.
        */}
        {payload === undefined ? (
          ''
        ) : (
          <script type="application/json" id="page-data">
            {json(payload)}
          </script>
        )}

        <div id={mountId} />
      </body>
    </html>
  )
}
