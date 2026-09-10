import type { EntryResult } from '../../entry-result.ts'
import { cellsFor } from './columns.ts'
import { Layout } from './layout.tsx'
import { labelFor, timeAgo } from './ui.ts'

export type EntryProps = {
  path: string
  entry: EntryResult
  /** Everything else recorded in the same unit of work. */
  batch: EntryResult[]
  paused: boolean
}

/**
 * One entry, and everything that happened alongside it.
 *
 * The second half is the point. An exception on its own says what broke; the
 * query that raised it and the request that ran it say why, and nothing relates
 * them but a shared batch id. Telescope's largest component by a wide margin is
 * the one that renders this, which is a fair signal of where the value is.
 */
export function Entry({ path, entry, batch, paused }: EntryProps) {
  const related = batch.filter((candidate) => candidate.uuid !== entry.uuid)
  const label = labelFor(entry.type)

  return (
    <Layout title={`${label} · Lens`} path={path} current={entry.type} paused={paused}>
      <a class="back" href={`/${path}/${entry.type}`} safe>
        {`← ${label}`}
      </a>

      <div class="card">
        <div class="card-head">
          <h2 safe>{label}</h2>
          <span class="muted" title={entry.createdAt ?? ''} safe>
            {timeAgo(entry.createdAt)}
          </span>
        </div>

        <div class="card-body">
          <dl class="kv">
            <dt>ID</dt>
            <dd>
              <code safe>{entry.uuid}</code>
            </dd>
            <dt>Recorded</dt>
            <dd safe>{entry.createdAt ?? ''}</dd>
            {entry.tags.length === 0 ? null : (
              <>
                <dt>Tags</dt>
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
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Content</h2>
        </div>
        <div class="card-body">
          <pre safe>{JSON.stringify(entry.content, null, 2)}</pre>
        </div>
      </div>

      {/*
       * The batch, and this is the feature.
       *
       * An exception says what broke; the query that raised it and the request
       * that ran it say why, and nothing relates them but a shared batch id.
       */}
      <div class="card">
        <div class="card-head">
          <h2 safe>{`Related · ${String(related.length)}`}</h2>
        </div>

        {related.length === 0 ? (
          <div class="blank">
            <span>Nothing else was recorded in this batch.</span>
          </div>
        ) : (
          <div class="wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Summary</th>
                  <th class="right">Happened</th>
                </tr>
              </thead>
              <tbody>
                {related.map((candidate) => (
                  <tr>
                    <td class="fit">
                      <a class="badge" href={`/${path}/${candidate.type}/${candidate.uuid}`} safe>
                        {labelFor(candidate.type)}
                      </a>
                    </td>
                    <td>
                      <code safe>{summarise(candidate)}</code>
                    </td>
                    <td class="fit right muted" title={candidate.createdAt ?? ''} safe>
                      {timeAgo(candidate.createdAt)}
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
 * One line describing an entry, whatever its type.
 *
 * Built from the same column definitions the lists use, rather than a
 * `JSON.stringify` fallback. Seen on a running dashboard, the related table read
 * `gate | {"ability":"access-admin","result":"denied","arguments":[],…}` — every
 * field there is in the columns already, and the columns say it in four words.
 */
function summarise(entry: EntryResult): string {
  const line = cellsFor(entry.type, entry.content)
    .map((cell) => cell.text)
    .filter((value) => value !== '' && value !== '-')
    .join(' · ')

  return line.length <= 140 ? line : `${line.slice(0, 139)}…`
}
