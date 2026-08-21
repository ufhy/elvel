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

/**
 * Three tones, two of which are the theme's own colours.
 *
 * `success` is the exception: nothing in a monochrome palette says "that
 * worked", so green is named outright — with a `dark:` pair, since it is a real
 * colour rather than a token that both themes already answer for.
 */
const tones = {
  info: 'bg-muted text-muted-foreground',
  success:
    'border-green-600/20 bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300',
  error: 'border-destructive/30 bg-destructive/10 text-destructive'
}

export function Alert({ message, tone = 'info', class: extra }: AlertProps) {
  // An empty string rather than a fragment: a component renders to a string, so
  // nothing is the honest representation of nothing.
  if (!message) return ''

  return (
    <div
      class={classes('rounded-md border px-4 py-3 text-sm', tones[tone], extra)}
      role={tone === 'error' ? 'alert' : 'status'}
      safe
    >
      {message}
    </div>
  )
}
