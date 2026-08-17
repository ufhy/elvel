import { config } from '@elyvel/core'
import type { Children } from '@kitajs/html'

export type LayoutProps = {
  title: string
  children?: Children
}

export function Layout({ title, children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <title safe>{title}</title>
      </head>
      <body>
        <main>{children}</main>
        <footer>
          {config<string>('app.name')}/{config<string>('app.env')}
        </footer>
      </body>
    </html>
  )
}
