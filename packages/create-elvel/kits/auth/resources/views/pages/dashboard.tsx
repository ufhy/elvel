import { csrfField } from '@elvel/http'
import { Layout } from '../components/layout.tsx'

export type DashboardProps = {
  title: string
  name: string
}

export function Dashboard({ title, name }: DashboardProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>
          Hello, <span safe>{name}</span>
        </h1>

        <p class="lede">
          You are signed in. This page is behind a check in the controller rather than a middleware
          string — `if (!user) return redirect('/sign-in').guest()` — so the redirect back here
          after signing in comes for free.
        </p>

        <form method="post" action="/sign-out" class="form">
          {csrfField()}

          <button type="submit">Sign out</button>
        </form>
      </section>
    </Layout>
  )
}
