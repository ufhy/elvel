import { classes } from '@elvel/view'

/**
 * A button, or a link that looks like one.
 *
 * `href` rather than a second component: the two differ by one tag, and every
 * duplicated variant afterwards is a place for them to drift apart.
 */
export type ButtonProps = {
  children?: JSX.Element
  /** `primary` is filled; `quiet` is a link carrying the same padding. */
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
  size?: 'sm' | 'md'
  href?: string
  type?: 'button' | 'submit'
  name?: string
  value?: string
  disabled?: boolean
  class?: string
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ' +
  'disabled:pointer-events-none disabled:opacity-50'

const variants = {
  // The mark's own red, used as a shape — the one place it is bright enough to
  // be right. See the note in resources/css/app.css.
  primary: 'bg-brand-strong text-white hover:bg-brand',
  secondary:
    'border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50 ' +
    'dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800',
  quiet: 'text-neutral-600 hover:text-brand dark:text-neutral-300 dark:hover:text-brand',
  danger: 'bg-red-600 text-white hover:bg-red-700'
}

const sizes = { sm: 'px-3 py-1.5 text-sm', md: 'px-5 py-2.5 text-sm' }

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  href,
  type = 'button',
  name,
  value,
  disabled,
  class: extra
}: ButtonProps) {
  const className = classes(base, variants[variant], sizes[size], extra)

  if (href !== undefined) {
    return (
      <a class={className} href={href}>
        {children}
      </a>
    )
  }

  return (
    <button class={className} type={type} name={name} value={value} disabled={disabled}>
      {children}
    </button>
  )
}
