import { csrfToken } from '@elvel/http'
import { Layout } from './layout.tsx'

export type MonitoringProps = {
  path: string
  tags: string[]
  paused: boolean
}

/**
 * The tags being monitored, and the form that changes them.
 *
 * What this screen is for, in one sentence: a production filter keeps only
 * failures, and this is how you say "and also keep everything belonging to this
 * one subject, starting now" — a customer whose problem you are chasing, a job
 * that misbehaves on Tuesdays — without a deploy and without keeping everything
 * for everybody.
 *
 * A tag is matched exactly against the tags an entry carries: `auth:41` from the
 * user attached to an entry, a model's `User:41`, a recipient's address on a
 * mail entry, or anything an application adds through `lens().tag()`.
 */
export function Monitoring({ path, tags, paused }: MonitoringProps) {
  return (
    <Layout title="Monitoring · Lens" path={path} current="monitoring" paused={paused}>
      <div class="card">
        <div class="card-head">
          <h2>Monitoring</h2>

          <form method="post" action={`/${path}/monitoring`} class="row">
            <CsrfInput />
            <input
              class="field"
              type="text"
              name="tag"
              placeholder="auth:41"
              aria-label="Tag to monitor"
            />
            <button class="btn" type="submit">
              Monitor
            </button>
          </form>
        </div>

        <div class="card-body">
          <p class="hint">
            An entry carrying one of these tags is kept even when a filter would otherwise drop it.
            Takes effect from the next request or job.
          </p>
        </div>

        {tags.length === 0 ? (
          <div class="blank">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5c-5 0-9 4.5-9 7s4 7 9 7 9-4.5 9-7-4-7-9-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
            </svg>
            <span>Nothing is being monitored.</span>
          </div>
        ) : (
          <div class="wrap">
            <table>
              <thead>
                <tr>
                  <th>Tag</th>
                  <th class="right" />
                </tr>
              </thead>
              <tbody>
                {tags.map((tag) => (
                  <tr>
                    <td>
                      <code safe>{tag}</code>
                    </td>
                    <td class="fit right">
                      <form method="post" action={`/${path}/monitoring/delete`}>
                        <CsrfInput />
                        <input type="hidden" name="tag" value={tag} safe />
                        <button type="submit" class="btn quiet">
                          Stop
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  )
}

/**
 * The CSRF field as JSX rather than `csrfField()`.
 *
 * `csrfField()` returns a string of markup, and interpolating markup is exactly
 * what the repository's XSS scanner objects to — rightly, since it cannot tell
 * trusted HTML from a value somebody sent.
 */
function CsrfInput() {
  return <input type="hidden" name="_token" value={csrfToken()} safe />
}
