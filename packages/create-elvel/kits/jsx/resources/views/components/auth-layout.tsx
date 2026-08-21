import { config } from '@elvel/core'
import type { Children } from '@kitajs/html'
import { Layout } from './layout.tsx'
import { Mark } from './ui/mark.tsx'

/**
 * The shell every page you can reach while signed **out** shares.
 *
 * Laravel's kits ship three variants of this — simple, card, split — because
 * they are built on a component library where switching is an import swap. Here a
 * page is a file you edit, so a second variant would be a copy of this one
 * waiting to fall behind it. This is the simple one: a mark, a title, a line of
 * explanation, and the form, centred in the viewport at `max-w-sm`.
 *
 * No card, deliberately. A bordered panel floating on a page with nothing else on
 * it is a box drawn around empty space; the form is the whole page here.
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
      <div class="flex min-h-dvh flex-col items-center justify-center gap-6 p-6 md:p-10">
        <div class="w-full max-w-sm">
          <div class="flex flex-col gap-8">
            <div class="flex flex-col items-center gap-4">
              <a
                class="flex flex-col items-center gap-2 font-medium transition-opacity hover:opacity-80"
                href="/"
                aria-label={name}
              >
                <span class="mb-1 flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Mark class="size-5" />
                </span>
              </a>

              <div class="space-y-2 text-center">
                <h1 class="text-xl font-medium" safe>
                  {heading}
                </h1>
                {description ? (
                  <p class="text-sm text-muted-foreground" safe>
                    {description}
                  </p>
                ) : null}
              </div>
            </div>

            {children}
          </div>
        </div>
      </div>
    </Layout>
  )
}
