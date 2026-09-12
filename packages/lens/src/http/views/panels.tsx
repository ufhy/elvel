import type { EntryTypeName } from '../../entry-type.ts'
import { describe, type Panel } from '../../panels/describe.ts'
import type { EntryContent } from './columns.ts'

/**
 * A detail page's body, as panels rather than one JSON dump.
 *
 * A dump is honest and unreadable: the thing somebody came for — the failing
 * line, the headers, what the handler answered — is three levels into a blob
 * they have to parse by eye. Telescope solves this with a Vue screen per type;
 * these are the same idea, and the JSON stays underneath in a `<details>` for
 * whatever a panel does not cover.
 *
 * *Which* panels an entry gets is not decided here. `panels/describe.ts` decides
 * it, because the inspection bar draws the same detail in the browser and a
 * second answer to "what is a query's detail" would drift from this one within a
 * release. This file is the mapping from that answer to markup, and nothing else.
 */
export function Panels({ type, content }: { type: EntryTypeName; content: EntryContent }) {
  return (
    <>
      {describe(type, content).map((panel) => (
        <Rendered panel={panel} />
      ))}

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
 * `{renderPanel(...)}` is an interpolated string as far as the XSS scanner can
 * tell — and it is right to object: it cannot see whether that string was
 * escaped. As an element it is markup by construction.
 */
function Rendered({ panel }: { panel: Panel }) {
  if (panel.kind === 'facts') return <Facts rows={panel.rows} />
  if (panel.kind === 'mapping') return <Mapping title={panel.title} value={panel.value} />
  if (panel.kind === 'block') return <Block title={panel.title} value={panel.value} />
  if (panel.kind === 'code') return <Code title={panel.title} value={panel.value} />
  if (panel.kind === 'source') return <Source lines={panel.lines} blame={panel.blame} />
  if (panel.kind === 'trace') return <Trace frames={panel.frames} />

  return <Preview html={panel.html} />
}

/**
 * The email as it was sent, in a sandboxed frame.
 *
 * Telescope's mail preview, and the reason the body is recorded at all: the
 * question about a transactional email is almost always what it actually looked
 * like. `srcdoc` with `sandbox` and no `allow-scripts`, because this is markup
 * an application generated from data somebody else supplied — rendering it into
 * the dashboard's own document would hand it the dashboard.
 */
function Preview({ html }: { html: string }) {
  return (
    <div class="card">
      <div class="card-head">
        <h2>Preview</h2>
      </div>
      <iframe class="preview" title="Message preview" sandbox="" srcdoc={html} />
    </div>
  )
}

/** A short list of named values — the answer, before the evidence. */
function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div class="card">
      <div class="card-body">
        <dl class="kv">
          {rows.map(([name, value]) => (
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

/** A record, as a two-column table. */
function Mapping({ title, value }: { title: string; value: Record<string, unknown> }) {
  return (
    <div class="card">
      <div class="card-head">
        <h2 safe>{title}</h2>
      </div>
      <div class="wrap">
        <table>
          <tbody>
            {Object.entries(value).map(([name, held]) => (
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
function Source({ lines, blame }: { lines: Array<[number, string]>; blame: number }) {
  return (
    <div class="card">
      <div class="card-head">
        <h2>Source</h2>
      </div>
      <div class="wrap">
        <table class="src">
          <tbody>
            {lines.map(([number, text]) => (
              <tr class={number === blame ? 'blame' : ''}>
                <td class="fit muted num" safe>
                  {String(number)}
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

function Trace({ frames }: { frames: Array<{ file: string; line: string }> }) {
  return (
    <div class="card">
      <div class="card-head">
        <h2 safe>{`Stack · ${String(frames.length)}`}</h2>
      </div>
      <div class="wrap">
        <table>
          <tbody>
            {frames.map((frame) => (
              <tr>
                <td>
                  <code safe>{frame.file}</code>
                </td>
                <td class="fit right muted" safe>
                  {frame.line}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
