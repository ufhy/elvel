import type { EntryResult } from '../../entry-result.ts'
import type { EntryTypeName } from '../../entry-type.ts'
import type { WatcherStatus } from '../status.ts'
import { type Column, columnsFor } from './columns.ts'
import { Layout } from './layout.tsx'

export type EntriesProps = {
  path: string
  type: EntryTypeName
  status: WatcherStatus
  entries: EntryResult[]
}

/**
 * The list for one entry type.
 *
 * Telescope gives each type its own Vue screen, nineteen of them, because the
 * interesting columns genuinely differ per type. They differ here too — but a
 * screen is a list of columns rather than a component, so the table, the link,
 * the paging and above all the **escaping** are written once. Every cell goes
 * through one `<td safe>`, which is what stops a new column from being the one
 * that forgets.
 */
export function Entries({ path, type, status, entries }: EntriesProps) {
  const columns = columnsFor(type)

  return (
    <Layout title={`${type} · Lens`} path={path} current={type} status={status}>
      <h1>{type}</h1>

      {entries.length === 0 ? (
        <p class="empty" safe>
          {emptyMessage(status)}
        </p>
      ) : (
        <div class="wrap">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th safe>{column.heading}</th>
                ))}
                <th class="num">when</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <Row path={path} entry={entry} columns={columns} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  )
}

/**
 * One row. The first cell links to the detail page, the rest are plain.
 *
 * Only the first, because a row of four links reads as four things to click
 * when it is one.
 */
function Row({ path, entry, columns }: { path: string; entry: EntryResult; columns: Column[] }) {
  const link = `/${path}/${entry.type}/${entry.uuid}`

  return (
    <tr>
      {columns.map((column, index) => (
        <td class={column.cellClass?.(entry.content)}>
          {index === 0 ? (
            <a href={link} safe>
              {column.text(entry.content)}
            </a>
          ) : (
            <span safe>{column.text(entry.content)}</span>
          )}
        </td>
      ))}
      <td class="num" safe>
        {entry.createdAt ?? ''}
      </td>
    </tr>
  )
}

function emptyMessage(status: WatcherStatus): string {
  return {
    disabled: 'Lens is disabled. Set LENS_ENABLED=true.',
    paused: 'Recording is paused. Run `elvel lens:resume`.',
    off: 'This watcher is switched off in config/lens.ts.',
    enabled: 'Nothing recorded yet.'
  }[status]
}
