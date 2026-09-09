import type { EntryResult } from '../../entry-result.ts'
import { EntryType, type EntryTypeName } from '../../entry-type.ts'
import type { WatcherStatus } from '../status.ts'
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
 * Telescope gives each type its own Vue screen, nineteen of them, because each
 * type's interesting columns differ. The same is true here, but a screen is a
 * function: `columnsFor` picks the row shape and everything else is shared.
 */
export function Entries({ path, type, status, entries }: EntriesProps) {
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
                {headingsFor(type).map((heading) => (
                  <th safe>{heading}</th>
                ))}
                <th class="num">when</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr>
                  {cellsFor(type, entry, path)}
                  <td class="num" safe>
                    {entry.createdAt ?? ''}
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

function emptyMessage(status: WatcherStatus): string {
  return {
    disabled: 'Lens is disabled. Set LENS_ENABLED=true.',
    paused: 'Recording is paused. Run `elvel lens:resume`.',
    off: 'This watcher is switched off in config/lens.ts.',
    enabled: 'Nothing recorded yet.'
  }[status]
}

function headingsFor(type: EntryTypeName): string[] {
  if (type === EntryType.REQUEST) return ['verb', 'path', 'status', 'took']
  if (type === EntryType.QUERY) return ['statement', 'connection', 'took']

  return ['entry']
}

function cellsFor(type: EntryTypeName, entry: EntryResult, path: string) {
  const link = `/${path}/${type}/${entry.uuid}`
  const content = entry.content

  if (type === EntryType.REQUEST) {
    const status = Number(content.responseStatus ?? 0)

    return (
      <>
        <td>
          <a class="method" href={link} safe>
            {String(content.method ?? '')}
          </a>
        </td>
        <td>
          <a href={link} safe>
            {String(content.uri ?? '')}
          </a>
        </td>
        <td class={`method s${Math.floor(status / 100)}`} safe>
          {String(status)}
        </td>
        <td class="num" safe>
          {`${String(content.duration ?? 0)} ms`}
        </td>
      </>
    )
  }

  if (type === EntryType.QUERY) {
    return (
      <>
        <td>
          <a href={link}>
            <code safe>{truncate(String(content.sql ?? ''), 120)}</code>
          </a>
          {content.slow === true ? <span class="tag">slow</span> : null}
        </td>
        <td safe>{String(content.connection ?? '')}</td>
        <td class="num" safe>
          {`${String(content.time ?? 0)} ms`}
        </td>
      </>
    )
  }

  return (
    <td>
      <a href={link}>
        <code safe>{truncate(JSON.stringify(content), 140)}</code>
      </a>
    </td>
  )
}

/** One line in a table, not a paragraph. The whole thing is on the detail page. */
function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}
