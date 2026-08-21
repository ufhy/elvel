import { classes } from '@elvel/view'

/**
 * A message about something that just happened.
 *
 * Renders nothing when there is nothing to say, so a page can hand it a flashed
 * value straight from the session without checking first.
 */
export type AlertProps = {
  message?: string | null
  tone?: 'info' | 'success' | 'error'
  class?: string
}

const tones = {
  info: 'border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200',
  success:
    'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200',
  error:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200'
}

export function Alert({ message, tone = 'info', class: extra }: AlertProps) {
  // An empty string rather than a fragment: a component renders to a string, so
  // nothing is the honest representation of nothing.
  if (!message) return ''

  return (
    <div
      class={classes('rounded-lg border px-4 py-3 text-sm', tones[tone], extra)}
      role={tone === 'error' ? 'alert' : 'status'}
      safe
    >
      {message}
    </div>
  )
}
