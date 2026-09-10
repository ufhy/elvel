import { csrfToken } from '@elvel/http'
import { Layout } from './layout.tsx'

export type MonitoringProps = {
  path: string
  tags: string[]
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
export function Monitoring({ path, tags }: MonitoringProps) {
  return (
    <Layout title="monitoring · Lens" path={path} current="monitoring">
      <h1>monitoring</h1>

      <p class="empty">
        An entry carrying one of these tags is kept even when a filter would otherwise drop it.
        Takes effect from the next request or job.
      </p>

      <form method="post" action={`/${path}/monitoring`} class="row">
        <CsrfInput />
        <input type="text" name="tag" placeholder="auth:41" aria-label="Tag to monitor" />
        <button type="submit">Monitor</button>
      </form>

      {tags.length === 0 ? (
        <p class="empty">Nothing is being monitored.</p>
      ) : (
        <div class="wrap">
          <table>
            <thead>
              <tr>
                <th>tag</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tags.map((tag) => (
                <tr>
                  <td>
                    <code safe>{tag}</code>
                  </td>
                  <td class="num">
                    <form method="post" action={`/${path}/monitoring/delete`}>
                      <CsrfInput />
                      <input type="hidden" name="tag" value={tag} safe />
                      <button type="submit" class="link">
                        stop
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <style>{STYLES}</style>
    </Layout>
  )
}

/**
 * The CSRF field as JSX rather than `csrfField()`.
 *
 * `csrfField()` returns a string of markup, and interpolating markup is exactly
 * what the repository's XSS scanner objects to — rightly, since it cannot tell
 * trusted HTML from a value somebody sent. Composing the same input here keeps
 * this package at zero findings.
 */
function CsrfInput() {
  return <input type="hidden" name="_token" value={csrfToken()} safe />
}

const STYLES = `
.row { display: flex; gap: 8px; margin: 0 0 20px; }
.row input[type="text"] {
  flex: 0 1 280px; padding: 6px 10px; border-radius: 7px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  font: inherit;
}
button {
  padding: 6px 12px; border-radius: 7px; border: 1px solid var(--line);
  background: var(--panel); color: var(--ink); font: inherit; cursor: pointer;
}
button:hover { border-color: var(--accent); color: var(--accent); }
button.link { border: 0; background: none; color: var(--dim); padding: 0; }
button.link:hover { color: var(--bad); }
`
