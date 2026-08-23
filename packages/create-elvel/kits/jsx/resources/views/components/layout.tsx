import { config } from '@elvel/core'
import { cspNonce } from '@elvel/http'
import { stack, vite } from '@elvel/view'
import type { Children } from '@kitajs/html'

export type LayoutProps = {
  title: string
  children?: Children
}

/**
 * Decide the theme before the first paint.
 *
 * This is inline, and it is inline on purpose. A `<script type="module">` is
 * deferred until after the document parses, which is after the browser has
 * already painted a white page — so a reader who chose dark gets a white flash
 * on every navigation. Reading `localStorage` and setting one class is the only
 * work that has to happen this early, so it is the only work that is here.
 *
 * `matchMedia` covers the third choice: "system" stores nothing and asks the
 * operating system, which is why the stored value can be absent and still mean
 * something deliberate.
 */
const appearance = `
(function () {
  try {
    var stored = localStorage.getItem('appearance') || 'system'
    var dark = stored === 'dark' ||
      (stored === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

    document.documentElement.classList.toggle('dark', dark)
  } catch (error) {
    /* Private windows can throw on the first read. A light page is a fine answer. */
  }
})()
`.trim()

/**
 * Page layout.
 *
 * There is no `@extends`/`@yield` and no template globals: a layout is a
 * component, the page body arrives as `children`, and shared values are simply
 * imported — `config()` here rather than something injected into a template
 * scope.
 *
 * `<!DOCTYPE html>` is prepended by `view()`, since JSX has no doctype node.
 *
 * The body takes its colours from tokens — `bg-background text-foreground` — so
 * this element needs no `dark:` variant, and neither does anything under it.
 * `resources/css/app.css` is where light and dark are actually decided.
 */
export function Layout({ title, children }: LayoutProps) {
  const name = config<string>('app.name', 'Elvel')

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <title safe>
          {title} — {name}
        </title>

        {/*
          The nonce is what lets this script run under the policy.

          `script-src` allows no inline script, because allowing them is allowing
          the injected one — so this carries the request's nonce and the policy
          names it. With the policy off `cspNonce()` is empty, and the attribute
          is inert rather than wrong.
        */}
        <script nonce={cspNonce()}>{appearance}</script>

        {/*
          Instrument Sans, the face Laravel's starter kits use, from Bunny's
          mirror of Google Fonts — the same host Laravel's `@fonts` points at,
          chosen there because it sets no cookies and logs no addresses.

          It is a network request, so `--font-sans` in the stylesheet lists the
          system stack behind it: offline, the page is a different face rather
          than a broken one.
        */}
        <link rel="preconnect" href="https://fonts.bunny.net" />
        <link
          rel="stylesheet"
          href="https://fonts.bunny.net/css?family=instrument-sans:400,500,600"
        />

        {/*
          The stylesheet and the script, from the build.
          While `bun run dev` is up these point at Vite's dev server, so a change
          reaches the browser without a rebuild; after `bun run build` they point
          at the hashed files in `public/build`, which is what stops a deploy
          serving yesterday's JavaScript to anybody with a warm cache.
        */}
        {vite(['resources/css/app.css', 'resources/js/app.ts'])}

        {/* Anything a page pushed to `head` lands here, even though this element
            rendered before that page's body ran. */}
        {stack('head')}
      </head>
      <body class="min-h-dvh font-sans antialiased">
        {children}
        {stack('scripts')}
      </body>
    </html>
  )
}
