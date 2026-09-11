import type { EntryResult } from '../../entry-result.ts'
import { headlineFor } from './columns.ts'
import { Layout } from './layout.tsx'
import { Panels } from './panels.tsx'
import { labelFor, timeAgo } from './ui.ts'
import { Waterfall } from './waterfall.tsx'

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
  const headline = headlineFor(entry.type, entry.content)

  return (
    <Layout title={`${label} · Lens`} path={path} current={entry.type} paused={paused}>
      <a class="back" href={`/${path}/${entry.type}`} safe>
        {`← ${label}`}
      </a>

      <div class="card">
        <div class="card-head">
          <h2 safe>{headline === '' ? label : headline}</h2>
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

      <Panels type={entry.type} content={entry.content} />

      {/*
       * The batch, and this is the feature.
       *
       * An exception says what broke; the query that raised it and the request
       * that ran it say why, and nothing relates them but a shared batch id.
       * Drawn on a time axis rather than listed, because the question people
       * arrive with is where the time went.
       */}
      <div class="card">
        <div class="card-head">
          <h2 safe>{`Timeline · ${String(related.length)} related`}</h2>
        </div>

        {related.length === 0 ? (
          <div class="blank">
            <span>Nothing else was recorded in this batch.</span>
          </div>
        ) : (
          <Waterfall path={path} batch={batch} current={entry.uuid} />
        )}
      </div>
    </Layout>
  )
}
