import { EntryType, type EntryTypeName } from '../../entry-type.ts'
import type { EntryContent } from './columns.ts'

/**
 * A detail page's body, as panels rather than one JSON dump.
 *
 * A dump is honest and unreadable: the thing somebody came for — the failing
 * line, the headers, what the handler answered — is three levels into a blob
 * they have to parse by eye. Telescope solves this with a Vue screen per type;
 * these are the same idea as functions, and the JSON stays underneath in a
 * `<details>` for whatever a panel does not cover.
 */
export function Panels({ type, content }: { type: EntryTypeName; content: EntryContent }) {
  return (
    <>
      <TypePanels type={type} content={content} />

      <div class="card">
        <details>
          <summary class="card-head">
            <h2>Raw content</h2>
          </summary>
          <div class="card-body">
            <pre safe>{JSON.stringify(content, null, 2)}</pre>
          </div>
        </details>
      </div>
    </>
  )
}

/**
 * A component rather than a helper returning markup.
 *
 * `@kitajs/html` renders a component to a **string**, so a bare
 * `{panelsFor(...)}` is an interpolated string as far as the XSS scanner can
 * tell — and it is right to object: it cannot see whether that string was
 * escaped. As an element it is markup by construction.
 */
function TypePanels({ type, content }: { type: EntryTypeName; content: EntryContent }) {
  if (type === EntryType.REQUEST) {
    return (
      <>
        <Facts
          rows={[
            ['Method', str(content.method)],
            ['URI', str(content.uri)],
            ['Route', str(content.route)],
            ['Status', str(content.responseStatus)],
            ['Duration', content.duration === undefined ? '' : `${str(content.duration)}ms`],
            ['Client', str(content.ipAddress)]
          ]}
        />
        <Mapping title="Headers" value={content.headers} />
        <Mapping title="Payload" value={content.payload} />
        <Mapping title="Session" value={content.session} />
        <Block title="Response" value={content.response} />
      </>
    )
  }

  if (type === EntryType.QUERY) {
    return (
      <>
        <Facts
          rows={[
            ['Connection', str(content.connection)],
            ['Duration', content.time === undefined ? '' : `${str(content.time)}ms`],
            ['Bindings', str(content.bindings)],
            ['Called from', where(content)]
          ]}
        />
        <Code title="Statement" value={str(content.sql)} />
      </>
    )
  }

  if (type === EntryType.EXCEPTION) {
    return (
      <>
        <Facts
          rows={[
            ['Type', str(content.class)],
            ['Message', str(content.message)],
            ['Where', where(content)],
            ['Seen', str(content.occurrences ?? 1)]
          ]}
        />
        <Source preview={content.linePreview} line={Number(content.line ?? 0)} />
        <Trace frames={content.trace} />
      </>
    )
  }

  return null
}

/** A short list of named values — the answer, before the evidence. */
function Facts({ rows }: { rows: Array<[string, string]> }) {
  const present = rows.filter(([, value]) => value !== '')

  if (present.length === 0) return null

  return (
    <div class="card">
      <div class="card-body">
        <dl class="kv">
          {present.map(([name, value]) => (
            <>
              <dt safe>{name}</dt>
              <dd>
                <code safe>{value}</code>
              </dd>
            </>
          ))}
        </dl>
      </div>
    </div>
  )
}

/** A record, as a two-column table. Empty ones are left out rather than shown blank. */
function Mapping({ title, value }: { title: string; value: unknown }) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null

  const rows = Object.entries(value as Record<string, unknown>)

  if (rows.length === 0) return null

  return (
    <div class="card">
      <div class="card-head">
        <h2 safe>{title}</h2>
      </div>
      <div class="wrap">
        <table>
          <tbody>
            {rows.map(([name, held]) => (
              <tr>
                <td class="fit muted" safe>
                  {name}
                </td>
                <td>
                  <code safe>{typeof held === 'string' ? held : JSON.stringify(held)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Block({ title, value }: { title: string; value: unknown }) {
  if (value === undefined || value === null || value === '') return null

  return (
    <div class="card">
      <div class="card-head">
        <h2 safe>{title}</h2>
      </div>
      <div class="card-body">
        <pre safe>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
      </div>
    </div>
  )
}

function Code({ title, value }: { title: string; value: string }) {
  if (value === '') return null

  return (
    <div class="card">
      <div class="card-head">
        <h2 safe>{title}</h2>
      </div>
      <div class="card-body">
        <pre safe>{value}</pre>
      </div>
    </div>
  )
}

/**
 * The source around a failure, with the failing line marked.
 *
 * The single most useful thing on an exception page, and the reason the watcher
 * reads the file at record time: by the time somebody looks, the deploy that
 * broke it may be three deploys ago.
 */
function Source({ preview, line }: { preview: unknown; line: number }) {
  if (preview === null || typeof preview !== 'object') return null

  const lines = Object.entries(preview as Record<string, string>)

  if (lines.length === 0) return null

  return (
    <div class="card">
      <div class="card-head">
        <h2>Source</h2>
      </div>
      <div class="wrap">
        <table class="src">
          <tbody>
            {lines.map(([number, text]) => (
              <tr class={Number(number) === line ? 'blame' : ''}>
                <td class="fit muted num" safe>
                  {number}
                </td>
                <td>
                  <code safe>{text}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Trace({ frames }: { frames: unknown }) {
  if (!Array.isArray(frames) || frames.length === 0) return null

  return (
    <div class="card">
      <div class="card-head">
        <h2 safe>{`Stack · ${String(frames.length)}`}</h2>
      </div>
      <div class="wrap">
        <table>
          <tbody>
            {frames.slice(0, 30).map((frame) => {
              const at = frame as { file?: unknown; line?: unknown }

              return (
                <tr>
                  <td>
                    <code safe>{str(at.file)}</code>
                  </td>
                  <td class="fit right muted" safe>
                    {str(at.line)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function where(content: EntryContent): string {
  const file = str(content.file)

  return file === '' ? '' : `${file}:${str(content.line)}`
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}
