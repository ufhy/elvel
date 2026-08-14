import { Layout } from '../components/layout.tsx'

export type MiddlewareRoute = {
  path: string
  declared: string
  expect: string
}

export type MiddlewareProps = {
  title: string
  /** Who is asking, so the page can say why it answered the way it did. */
  signedIn: boolean
  email: string | null
  routes: MiddlewareRoute[]
  signedLink: string
}

/**
 * Generated with `bun run playground make:view pages/middleware`, then extended.
 *
 * Somewhere to *see* route middleware, rather than a JSON route somebody has to
 * know the path of. Every row is a link: follow it and the browser lands wherever
 * the middleware sent it — the sign-in page, a 403, a 429 — with the address bar
 * showing which.
 *
 * The page itself carries no middleware. It has to be reachable by a guest, since
 * a guest is who most of these rows are demonstrating.
 */
export function Middleware({ title, signedIn, email, routes, signedLink }: MiddlewareProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Route middleware</h1>

        <p class="lede">
          Said on the route, not checked inside the handler. Follow a link and watch where the
          middleware sends you — the address bar is the assertion.
        </p>

        <p class={signedIn ? 'notice' : 'muted'}>
          {signedIn ? (
            <>
              Signed in as <strong safe>{email ?? ''}</strong>. The rows needing a guest will turn
              you away now, and the rows needing a session will let you through.
            </>
          ) : (
            <>
              You are a guest. Sign up at <a href="/sign-up">/sign-up</a> — if the auth kit is
              installed — or through <code>POST /api/auth/sign-up/email</code>, then reload this
              page and watch the answers swap over.
            </>
          )}
        </p>

        <table class="routes">
          <thead>
            <tr>
              <th>Route</th>
              <th>Declared as</th>
              <th>What should happen{signedIn ? ' to you' : ' to a guest'}</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((route) => (
              <tr>
                <td>
                  <a href={route.path} safe>
                    {route.path}
                  </a>
                </td>
                <td>
                  <code safe>{route.declared}</code>
                </td>
                <td safe>{route.expect}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section class="panel">
        <h2>A signed link</h2>

        <p class="lede">
          The signature covers the path and every parameter. Follow it as it is, then edit{' '}
          <code>list=7</code> in the address bar and reload — a 200 becomes a 403.
        </p>

        <p>
          <a href={signedLink} safe>
            {signedLink}
          </a>
        </p>
      </section>
    </Layout>
  )
}
