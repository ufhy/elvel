import { errors, old } from '@elvel/http'
import { classes } from '@elvel/view'

/**
 * A text field that already knows how a rejected form behaves.
 *
 * `old()` and `errors()` read the request rather than taking props, because a
 * component has no scope to share an error bag into. So a form that came back
 * rejected keeps what was typed and says why, without the page threading
 * anything through.
 */
export type InputProps = {
  name: string
  type?: 'text' | 'email' | 'password' | 'url' | 'number'
  label?: string
  placeholder?: string
  value?: string
  required?: boolean
  autocomplete?: string
  /** A password must never be repopulated from flashed input. */
  keepValue?: boolean
  class?: string
}

export function Input({
  name,
  type = 'text',
  label,
  placeholder,
  value,
  required,
  autocomplete,
  keepValue = type !== 'password',
  class: extra
}: InputProps) {
  const message = errors().first(name)
  const filled = value ?? (keepValue ? old(name) : '')

  return (
    <div class={classes('space-y-1.5', extra)}>
      {label ? (
        <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-200" for={name}>
          {label}
        </label>
      ) : null}

      <input
        class={classes(
          'block w-full rounded-lg border bg-white px-3 py-2 text-sm text-neutral-900',
          'placeholder:text-neutral-400 focus:outline-2 focus:outline-offset-0 focus:outline-brand',
          'dark:bg-neutral-900 dark:text-neutral-100',
          message
            ? 'border-red-500 dark:border-red-500'
            : 'border-neutral-300 dark:border-neutral-700'
        )}
        id={name}
        name={name}
        type={type}
        value={filled}
        placeholder={placeholder}
        required={required}
        autocomplete={autocomplete}
        aria-invalid={message ? 'true' : undefined}
        aria-describedby={message ? `${name}-error` : undefined}
      />

      {message ? (
        <p class="text-sm text-red-600 dark:text-red-400" id={`${name}-error`} safe>
          {message}
        </p>
      ) : null}
    </div>
  )
}
