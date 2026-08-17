import { config } from '@elyvel/core'
import { stack } from '@elyvel/view'
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
 */
export function Layout({ title, children }: LayoutProps) {
  const name = config<string>('app.name', 'Elyvel')
  const environment = config<string>('app.env', 'production')

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title safe>
          {title} — {name}
        </title>
        <link rel="stylesheet" href="/css/app.css" />

        {/* Anything a page pushed to `head` lands here, even though this element
            rendered before that page's body ran. */}
        {stack('head')}
      </head>
      <body>
        <main class="shell">{children}</main>

        <footer class="footer">
          <span safe>{name}</span>
          <span class="dot">·</span>
          <span safe>{environment}</span>
        </footer>

        {stack('scripts')}
      </body>
    </html>
  )
}
