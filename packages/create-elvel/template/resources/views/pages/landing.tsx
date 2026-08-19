import { Layout } from '../components/layout.tsx'

export type LandingProps = {
  title: string
}

export function Landing({ title }: LandingProps) {
  return (
    <Layout title={title}>
      <section class="hero">
        <p class="eyebrow">Elvel</p>

        <h1>
          The Laravel developer experience,
          <br />
          <span class="accent">on Elysia and Bun.</span>
        </h1>

        <p class="lede">
          Service providers, an Artisan-style CLI, and typed JSX views — running on Bun's HTTP
          server with Elysia's end-to-end type inference intact.
        </p>

        <div class="cards">
          <article class="card">
            <h2>Routes</h2>
            <p>
              Controllers are Elysia instances, so handlers keep full context inference. Edit{' '}
              <code>app/Http/Controllers/PageController.ts</code>.
            </p>
          </article>

          <article class="card">
            <h2>Views</h2>
            <p>
              JSX compiled straight to strings by @kitajs/html — props are typechecked. Edit{' '}
              <code>resources/views/pages/landing.tsx</code>.
            </p>
          </article>

          <article class="card">
            <h2>Elvel</h2>
            <p>
              Generate code and inspect the app: <code>bun run elvel make:controller Post</code>.
            </p>
          </article>
        </div>

        <p class="hint">
          Try <code>bun run elvel route:list</code> and <code>bun run elvel about</code>.
        </p>
      </section>
    </Layout>
  )
}
