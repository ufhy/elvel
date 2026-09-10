import type { EntryResult } from '../../entry-result.ts'
import { columnsFor } from './columns.ts'
import { Layout } from './layout.tsx'

export type EntryProps = {
  path: string
  entry: EntryResult
  /** Everything else recorded in the same unit of work. */
  batch: EntryResult[]
}

/**
 * One entry, and everything that happened alongside it.
 *
 * The second half is the point. An exception on its own says what broke; the
 * query that raised it and the request that ran it say why, and nothing relates
 * them but a shared batch id. Telescope's largest component by a wide margin is
 * the one that renders this, which is a fair signal of where the value is.
 */
export function Entry({ path, entry, batch }: EntryProps) {
  const related = batch.filter((candidate) => candidate.uuid !== entry.uuid)

  return (
    <Layout title={`${entry.type} · Lens`} path={path} current={entry.type}>
      <a class="back" href={`/${path}/${entry.type}`} safe>
        {`← ${entry.type}`}
      </a>

      <h1>{entry.type}</h1>

      <dl class="kv">
        <dt>id</dt>
        <dd>
          <code safe>{entry.uuid}</code>
        </dd>
        <dt>recorded</dt>
        <dd safe>{entry.createdAt ?? ''}</dd>
        {entry.tags.length === 0 ? null : (
          <>
            <dt>tags</dt>
            <dd>
              {entry.tags.map((tag) => (
                <span class="tag" safe>
                  {tag}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>

      <h2>content</h2>
      <pre safe>{JSON.stringify(entry.content, null, 2)}</pre>

      <h2 safe>{`related · ${String(related.length)}`}</h2>

      {related.length === 0 ? (
        <p class="empty">Nothing else was recorded in this batch.</p>
      ) : (
        <div class="wrap">
          <table>
            <thead>
              <tr>
                <th>type</th>
                <th>summary</th>
              </tr>
            </thead>
            <tbody>
              {related.map((candidate) => (
                <tr>
                  <td>
                    <a href={`/${path}/${candidate.type}/${candidate.uuid}`}>{candidate.type}</a>
                  </td>
                  <td>
                    <code safe>{summarise(candidate)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  )
}

/**
 * One line describing an entry, whatever its type.
 *
 * Built from the same column definitions the lists use, rather than a
 * `JSON.stringify` fallback. Seen on a running dashboard, the related table read
 * `gate | {"ability":"access-admin","result":"denied","arguments":[],…}` — every
 * field there is in the columns already, and the columns say it in four words.
 */
function summarise(entry: EntryResult): string {
  const line = columnsFor(entry.type)
    .map((column) => column.text(entry.content))
    .filter((value) => value !== '')
    .join(' · ')

  return line.length <= 140 ? line : `${line.slice(0, 139)}…`
}
