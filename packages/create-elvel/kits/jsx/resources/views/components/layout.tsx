import { config } from '@elvel/core'
import { stack, vite } from '@elvel/view'
import type { Children } from '@kitajs/html'

export type LayoutProps = {
  title: string
  children?: Children
}

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
 * The body carries the page's background rather than a stylesheet rule, because
 * with Tailwind there is no stylesheet to put it in — and `bg-white` next to
 * `dark:bg-neutral-950` says which is which at the place it applies.
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
      <body class="min-h-dvh bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        {children}
        {stack('scripts')}
      </body>
    </html>
  )
}
