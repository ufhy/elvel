import { config } from '@elvel/core'
import type { Children } from '@kitajs/html'
import { Layout } from './layout.tsx'
import { Card } from './ui/card.tsx'
import { Mark } from './ui/mark.tsx'

/**
 * The shell every page you can reach while signed **out** shares.
 *
 * One layout rather than the three variants Laravel's kits offer. Those exist
 * because those kits are built on a component library and switching is an import
 * swap; here a page is a file you edit, so a second variant would be a copy of
 * this one waiting to fall behind it.
 */
export function AuthLayout({
  title,
  heading,
  description,
  children
}: {
  title: string
  heading: string
  description?: string
  children?: Children
}) {
  const name = config<string>('app.name', 'Elvel')

  return (
    <Layout title={title}>
      <div class="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
        <a
          class="mb-8 inline-flex items-center gap-2 text-brand transition-opacity hover:opacity-80"
          href="/"
        >
          <Mark />
          <span class="text-xs font-semibold tracking-[0.22em] uppercase" safe>
            {name}
          </span>
        </a>

        <Card class="w-full max-w-sm">
          <div class="mb-6 space-y-1.5 text-center">
            <h1 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50" safe>
              {heading}
            </h1>
            {description ? (
              <p class="text-sm text-neutral-600 dark:text-neutral-400" safe>
                {description}
              </p>
            ) : null}
          </div>

          {children}
        </Card>
      </div>
    </Layout>
  )
}
