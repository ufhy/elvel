import { Layout } from './layout.tsx'

export type NoticeProps = {
  path: string
  title: string
  message: string
  /** The commands or edits that fix it, in order. */
  steps?: string[]
  /** Where the answer lives, when it is a file somebody has to open. */
  file?: string
}

/**
 * A page that says what went wrong and what to do about it.
 *
 * Written after trying Lens the way somebody installing it would. The two most
 * likely first mistakes — forgetting the migration, and not opening the gate —
 * answered with a SQLite stack trace and the single word `Forbidden`. Neither
 * is wrong, exactly; both leave a person to guess, and the answer in each case
 * fits in a sentence and two commands.
 */
export function Notice({ path, title, message, steps, file }: NoticeProps) {
  return (
    <Layout title={`${title} · Lens`} path={path}>
      <div class="card">
        <div class="card-head">
          <h2 safe>{title}</h2>
        </div>
        <div class="card-body">
          <p class="hint" safe>
            {message}
          </p>

          {steps === undefined || steps.length === 0 ? null : (
            <ol class="steps">
              {steps.map((step) => (
                <li>
                  <code safe>{step}</code>
                </li>
              ))}
            </ol>
          )}

          {file === undefined ? null : (
            <p class="hint">
              <span>The answer lives in </span>
              <code safe>{file}</code>
            </p>
          )}
        </div>
      </div>
    </Layout>
  )
}
