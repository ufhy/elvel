import { Layout } from '../components/layout.tsx'

export type WelcomeProps = {
  title: string
  /** Shown in the header when the application has somebody signed in. */
  user?: { name: string } | null
  /** Which auth routes exist, so the header offers only what is really there. */
  links?: { login?: string; register?: string; dashboard?: string }
}

const steps = [
  ['Edit the route that served this page', 'routes/web.ts'],
  ['Edit this page itself', 'resources/views/pages/welcome.tsx'],
  ['Decide what the application registers', 'bootstrap/providers.ts'],
  ['Then read the rest', 'ufhy.github.io/elvel']
] as const

/**
 * The same welcome page as the template's, written in Tailwind.
 *
 * There are two copies on purpose and only two, split on the one thing that
 * actually differs between kits: whether Tailwind is installed. The template's is
 * hand-written CSS in a `<style>` block, because `--kit=none` and `--kit=api` have
 * no Tailwind and a page that needs a build to look finished is a poor first
 * minute. This one is the same page for the kits that do — and it lives in the
 * `auth` layer because `jsx` and `vue` are the two that layer on it, which makes it
 * exactly the set that has Tailwind.
 *
 * **Every measure below is the other page's, to the number.** They were compared in
 * a browser at 1280px and the figures are literal rather than the nearest utility:
 * Tailwind's type scale has no 73.6px, and taking `text-6xl` instead rendered the
 * headline a visible step small. `tests/template.test.ts` holds the two in step.
 *
 * The palette is the page's own rather than the kit's tokens, for the same reason:
 * `jsx` and `vue` are white and neutral, and this page is cream and warm in every
 * kit or it is not the same page.
 */
export function Welcome({ title, user, links }: WelcomeProps) {
  const nav = links ?? {}
  const hasAuth = Boolean(nav.login || nav.register || nav.dashboard)

  return (
    <Layout title={title}>
      {/*
        The page paints its own background, and one line of CSS is how.

        `body` belongs to the kit's layout — white in both of these, because every
        other page in them is — and a Tailwind class cannot reach it from here. A
        wrapper does not do it either: the footer is the layout's, outside anything
        this page renders, so the cream stopped above it. Measured with a full-page
        screenshot, a `fixed inset-0` layer left a white band below the fold.

        So the background is stated the same way the template's copy states it, and
        for the same reason: this page is cream in every kit or it is not the same
        page.
      */}
      <style>
        {'body{background:#fbf9f5}@media(prefers-color-scheme:dark){body{background:#121110}}'}
      </style>

      <div class="mx-auto max-w-[62rem] px-6 pt-10 pb-16 text-[#17150f] dark:text-[#ece7dc]">
        <header class="flex items-center justify-between gap-4 border-b border-[#ddd7c9] pb-5 dark:border-[#302c25]">
          <span class="flex items-center gap-2 text-[#c9241a] dark:text-[#ff6b5e]">
            <svg
              class="size-5"
              viewBox="0 0 48 48"
              fill="none"
              role="img"
              aria-label="Elvel"
              width="20"
              height="20"
            >
              <path
                d="M31 10H17a7 7 0 0 0-7 7v14a7 7 0 0 0 7 7h14"
                stroke="currentColor"
                stroke-width="4"
                stroke-linecap="round"
              />
              <path d="M17 24h10" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
            </svg>
            <span class="font-mono text-[0.7rem] tracking-[0.22em] uppercase">Elvel</span>
          </span>

          {hasAuth ? (
            <nav class="flex items-center gap-2 font-mono text-[0.8rem]">
              {user ? (
                <>
                  <span class="hidden text-[#6f6a5d] sm:block dark:text-[#9a9285]" safe>
                    {user.name}
                  </span>
                  {nav.dashboard ? (
                    <a
                      class="rounded-md border border-[#ddd7c9] px-3 py-1.5 no-underline dark:border-[#302c25]"
                      href={nav.dashboard}
                    >
                      Dashboard
                    </a>
                  ) : null}
                </>
              ) : (
                <>
                  {nav.login ? (
                    <a class="px-3 py-1.5 no-underline" href={nav.login}>
                      Log in
                    </a>
                  ) : null}
                  {nav.register ? (
                    <a
                      class="rounded-md border border-[#ddd7c9] px-3 py-1.5 no-underline dark:border-[#302c25]"
                      href={nav.register}
                    >
                      Register
                    </a>
                  ) : null}
                </>
              )}
            </nav>
          ) : null}
        </header>

        <section class="pt-16 pb-14">
          <h1 class="font-serif text-[clamp(2.6rem,7vw,4.6rem)] leading-[1.02] tracking-[-0.02em]">
            Laravel's shape,
            <br />
            <em class="text-[#c9241a] dark:text-[#ff6b5e]">on Bun.</em>
          </h1>

          <p class="mt-[1.6rem] max-w-[34rem] font-serif text-[1.07rem] leading-[1.65] text-[#6f6a5d] dark:text-[#9a9285]">
            Service providers, a CLI, migrations and typed JSX views — over Elysia's HTTP server,
            with its type inference intact all the way into your handlers.
          </p>
        </section>

        <section class="grid gap-10 border-t border-[#ddd7c9] pt-10 sm:grid-cols-2 dark:border-[#302c25]">
          <div class="min-w-0">
            <p class="mb-[1.4rem] font-mono text-[0.7rem] tracking-[0.2em] text-[#6f6a5d] uppercase dark:text-[#9a9285]">
              Let's get started
            </p>

            <ol class="m-0 list-none p-0">
              {steps.map(([label, where], index) => (
                <li class="relative flex gap-[0.9rem] pb-6 font-serif text-[0.95rem] leading-[1.5]">
                  {index < steps.length - 1 ? (
                    <span class="absolute top-[1.1rem] bottom-[0.2rem] left-[0.28rem] border-l border-[#ddd7c9] dark:border-[#302c25]" />
                  ) : null}

                  <span
                    class={
                      index === 0
                        ? 'mt-[0.42rem] size-[0.6rem] shrink-0 rounded-full border border-[#c9241a] bg-[#c9241a] dark:border-[#ff6b5e] dark:bg-[#ff6b5e]'
                        : 'mt-[0.42rem] size-[0.6rem] shrink-0 rounded-full border border-[#ddd7c9] bg-white dark:border-[#302c25] dark:bg-[#1a1917]'
                    }
                  />

                  <div>
                    {label}
                    {where.includes('.ts') ? (
                      <code class="mt-[0.35rem] block font-mono text-[0.82rem] text-[#6f6a5d] dark:text-[#9a9285]">
                        {where}
                      </code>
                    ) : (
                      <a
                        class="mt-[0.35rem] block font-mono text-[0.82rem] text-[#c9241a] dark:text-[#ff6b5e]"
                        href={`https://${where}/`}
                      >
                        {where}
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div class="min-w-0">
            <p class="mb-[1.4rem] font-mono text-[0.7rem] tracking-[0.2em] text-[#6f6a5d] uppercase dark:text-[#9a9285]">
              From here
            </p>

            <pre class="overflow-x-auto rounded-[0.6rem] border border-[#ddd7c9] bg-white p-4 font-mono text-[0.8rem] leading-[1.9] dark:border-[#302c25] dark:bg-[#1a1917]">
              <span class="text-[#c9241a] dark:text-[#ff6b5e]">$</span> bun run elvel{' '}
              <span class="text-[#6f6a5d] dark:text-[#9a9285]"># everything this app can do</span>
              {'\n'}
              <span class="text-[#c9241a] dark:text-[#ff6b5e]">$</span> bun run elvel route:list
              {'\n'}
              <span class="text-[#c9241a] dark:text-[#ff6b5e]">$</span> bun run elvel
              make:controller Post -r{'\n'}
              <span class="text-[#c9241a] dark:text-[#ff6b5e]">$</span> bun run dev{' '}
              <span class="text-[#6f6a5d] dark:text-[#9a9285]">
                # the server and Vite, together
              </span>
            </pre>

            <p class="mt-3 font-serif text-[0.85rem] leading-[1.6] text-[#6f6a5d] dark:text-[#9a9285]">
              A command exists only if its package is registered, so that first line is the honest
              list — not the framework's.
            </p>
          </div>
        </section>
      </div>
    </Layout>
  )
}
