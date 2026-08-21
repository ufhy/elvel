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
    <div class={classes('grid gap-2', extra)}>
      {label ? (
        <label class="text-sm leading-none font-medium" for={name}>
          {label}
        </label>
      ) : null}

      <input
        class={classes(
          'h-9 w-full rounded-md border bg-transparent px-3 py-1 text-base shadow-xs',
          'transition-[color,box-shadow] outline-none md:text-sm',
          'placeholder:text-muted-foreground',
          'focus-visible:ring-[3px] focus-visible:ring-brand/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
          message ? 'border-destructive ring-destructive/20' : 'border-input'
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
        <p class="text-sm text-destructive" id={`${name}-error`} safe>
          {message}
        </p>
      ) : null}
    </div>
  )
}
