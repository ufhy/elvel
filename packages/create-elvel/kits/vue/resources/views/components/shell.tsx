import { config } from '@elvel/core'
import { vite } from '@elvel/vite/tags'

export type ShellProps = {
  /** The Vite entry this document boots, as the manifest names it. */
  entry: string
}

/**
 * The document the Vue client boots from — this kit's own, not the framework's.
 *
 * `@elvel/spa` exports a `Document` that renders the same shape, and `routes/view.ts`
 * used to point at it. This is a view instead, for the reason every other page in
 * this application is a view: it is markup, it belongs in `resources/views/`, and
 * changing what a document carries should not mean reading a framework package to
 * find out what is allowed.
 *
 * The entry is the only prop, because it is the only thing the two routes disagree
 * about — a guest boots the auth bundle, everybody else the application. Everything
 * else a document carries is written here as markup: the icon is a `<link>` rather
 * than a string of HTML handed in from a route, which is one less place for
 * unescaped markup to enter a page.
 *
 * There is no payload. `spa.embed` is off, so the same bytes go to everybody and a
 * cache may keep them; each screen asks for what it needs through `/api`.
 *
 * The asset tags come from `vite()` and nothing here writes a `<script>` of its
 * own. That is load-bearing: `vite()` points at the dev server while one is
 * running, at the manifest afterwards, and carries whatever the other Vite plugins
 * injected — Vue DevTools, a service worker registration. A document assembling its
 * own tags would silently drop all of it.
 */
export function Shell({ entry }: ShellProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />

        {/*
          The application's name, and only that.

          A per-screen title would be a second place to keep them: the Vue router
          already sets `document.title` from each route's `meta.title`, and it runs
          before anybody reads the tab. What this needs to do is not be empty, so a
          tab has a name during the first paint.
        */}
        <title safe>{config<string>('app.name', 'Elvel')}</title>

        {vite([entry])}

        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body>
        {/*
          The id, and a marker that does not depend on it.

          `frontend/src/main.ts` mounts on `[data-spa-root]` rather than on `#app`,
          so the two files need no agreement about a string: changing `spa.mountId`
          would otherwise render a `<div>` the client never finds, with no error and
          no console message — the application simply does not appear.

          The id stays, because it is what a stylesheet or an external script would
          reach for.
        */}
        <div id={config<string>('spa.mountId', 'app')} data-spa-root />
      </body>
    </html>
  )
}
