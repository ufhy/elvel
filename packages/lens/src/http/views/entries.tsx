import type { EntryResult } from '../../entry-result.ts'
import type { EntryTypeName } from '../../entry-type.ts'
import type { WatcherStatus } from '../status.ts'
import { type Cell, cellsFor, headingsFor } from './columns.ts'
import { Layout } from './layout.tsx'
import { labelFor, timeAgo } from './ui.ts'

export type EntriesProps = {
  path: string
  type: EntryTypeName
  status: WatcherStatus
  paused: boolean
  entries: EntryResult[]
  /** How many were asked for, so "there may be more" can be told from "that's all". */
  limit: number
  /** The tag the list is filtered by, if any. */
  tag?: string
}

/**
 * The list for one entry type — Telescope's `IndexScreen`, server-rendered.
 *
 * Its shape is theirs because theirs is right: a card whose header carries the
 * title and the tag filter, a banner when the watcher is not recording, a real
 * empty state rather than a blank rectangle, and a footer row that loads older
 * entries instead of numbered pages. Paging by cursor is the only kind that
 * works when rows arrive while somebody is reading.
 */
export function Entries({ path, type, status, paused, entries, limit, tag }: EntriesProps) {
  const label = labelFor(type)
  const oldest = entries.at(-1)?.sequence

  return (
    <Layout title={`${label} · Lens`} path={path} current={type} paused={paused}>
      <div class="card">
        <div class="card-head">
          <h2 safe>{label}</h2>

          <form method="get" action={`/${path}/${type}`} class="filter">
            <input
              type="search"
              name="tag"
              value={tag ?? ''}
              placeholder="Search tag"
              aria-label="Filter by tag"
              safe
            />
          </form>
        </div>

        {status === 'enabled' ? null : <Banner status={status} />}

        {entries.length === 0 ? (
          <div class="blank">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm-3 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM8 16h8v1.5H8Z" />
            </svg>
            <span safe>{emptyMessage(status)}</span>
          </div>
        ) : (
          <div class="wrap">
            <table>
              <thead>
                <tr>
                  {headingsFor(type).map((heading) => (
                    <th class={heading.align ?? ''} safe>
                      {heading.label}
                    </th>
                  ))}
                  <th class="right">Happened</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <Row path={path} entry={entry} cells={cellsFor(type, entry.content)} />
                ))}

                {entries.length < limit || oldest === undefined ? null : (
                  <tr>
                    <td class="more" colspan="100">
                      <a href={`/${path}/${type}?beforeSequence=${String(oldest)}`}>
                        Load Older Entries
                      </a>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  )
}

/** One row: the first cell links, the rest are plain. */
function Row({ path, entry, cells }: { path: string; entry: EntryResult; cells: Cell[] }) {
  const link = `/${path}/${entry.type}/${entry.uuid}`

  return (
    <tr>
      {cells.map((cell, index) => (
        <td class={cellClass(cell)} title={cell.title ?? ''}>
          {cell.tone === undefined ? (
            index === 0 ? (
              <a href={link} safe>
                {cell.text}
              </a>
            ) : (
              <span safe>{cell.text}</span>
            )
          ) : (
            <a href={link}>
              <span class={`badge ${cell.tone}`} safe>
                {cell.text}
              </span>
            </a>
          )}
        </td>
      ))}
      <td class="fit right muted" title={entry.createdAt ?? ''} safe>
        {timeAgo(entry.createdAt)}
      </td>
    </tr>
  )
}

function cellClass(cell: Cell): string {
  return [
    cell.align ?? '',
    cell.tone === undefined ? '' : 'fit',
    cell.muted === true ? 'muted' : ''
  ]
    .filter((part) => part !== '')
    .join(' ')
}

function Banner({ status }: { status: WatcherStatus }) {
  return (
    <p class="banner">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2 1 21h22L12 2Zm0 5 7.5 13h-15L12 7Zm-1 4v4h2v-4Zm0 5v2h2v-2Z" />
      </svg>
      <span safe>{bannerMessage(status)}</span>
    </p>
  )
}

function bannerMessage(status: WatcherStatus): string {
  return {
    disabled: 'Lens is currently disabled.',
    paused: 'Lens recording is paused.',
    off: 'This watcher is turned off.',
    enabled: ''
  }[status]
}

function emptyMessage(status: WatcherStatus): string {
  return {
    disabled: 'Nothing here — Lens is disabled. Set LENS_ENABLED=true.',
    paused: 'Nothing here — recording is paused.',
    off: 'Nothing here — this watcher is off in config/lens.ts.',
    enabled: "We didn't find anything — just empty space."
  }[status]
}
