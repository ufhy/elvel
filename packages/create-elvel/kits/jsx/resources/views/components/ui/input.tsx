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
  /**
   * The element id, when it cannot be the field name.
   *
   * Two forms on one page can want the same field — the two-factor challenge
   * posts `code` to one route and a recovery `code` to another — and two elements
   * sharing an id means a label pointing at whichever the browser found first.
   */
  id?: string
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
  id = name,
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
      {/*
        `safe`, because this is somebody else's string.

        Every label this kit passes is a literal, so nothing here is exploitable as
        shipped — but a component is reused, and the caller who writes
        `label={field.title}` from a database has no reason to suspect that text
        interpolation is raw while the `value` attribute below it is escaped. A
        reusable component is the wrong place to leave that asymmetry.
      */}
      {label ? (
        <label class="text-sm leading-none font-medium" for={id} safe>
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
        id={id}
        name={name}
        type={type}
        value={filled}
        placeholder={placeholder}
        required={required}
        autocomplete={autocomplete}
        aria-invalid={message ? 'true' : undefined}
        aria-describedby={message ? `${id}-error` : undefined}
      />

      {message ? (
        <p class="text-sm text-destructive" id={`${id}-error`} safe>
          {message}
        </p>
      ) : null}
    </div>
  )
}
