import { errors, old } from '@elyvel/http'
import { Layout } from '../components/layout.tsx'

export type SubscribeProps = {
  title: string
  token: string
}

/**
 * A form that reports its own failures.
 *
 * `errors()` and `old()` take no props: they read the session of the request being
 * rendered. That is the whole point of the request scope — threading a message bag
 * down through every component between the handler and the input it belongs to is
 * the plumbing that makes people skip validation feedback altogether.
 */
export function Subscribe({ title, token }: SubscribeProps) {
  const bag = errors()

  return (
    <Layout title={title}>
      <h1 safe>{title}</h1>

      {bag.has() && (
        <div class="errors" role="alert">
          <p>{`${bag.count()} problem(s):`}</p>
          <ul>
            {bag.all().map((message) => (
              <li safe>{message}</li>
            ))}
          </ul>
        </div>
      )}

      <form method="post" action="/subscribe">
        <input type="hidden" name="_token" value={token} />

        <label>
          Email
          {/* Refilled from the last attempt, so a rejected form is not blank. */}
          <input type="email" name="email" value={old('email')} />
        </label>
        {bag.has('email') && (
          <p class="error" safe>
            {bag.first('email')}
          </p>
        )}

        <label>
          Name
          <input type="text" name="name" value={old('name')} />
        </label>
        {bag.has('name') && (
          <p class="error" safe>
            {bag.first('name')}
          </p>
        )}

        <label>
          Password
          {/* Never refilled: a password must not survive in the session. */}
          <input type="password" name="password" value={old('password')} />
        </label>
        {bag.has('password') && (
          <p class="error" safe>
            {bag.first('password')}
          </p>
        )}

        <button type="submit">Subscribe</button>
      </form>
    </Layout>
  )
}
