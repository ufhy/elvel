import { classes } from '@elvel/view'
import type { Children } from '@kitajs/html'

/**
 * A button, or a link that looks like one.
 *
 * `href` rather than a second component: the two differ by one tag, and every
 * duplicated variant afterwards is a place for them to drift apart.
 *
 * The shape is Laravel's — a `rounded-md` control the height of a form field, so
 * a button next to an input lines up with it. The colours are roles rather than
 * greys, which is why no variant here carries a `dark:` class.
 */
export type ButtonProps = {
  /** `Children` rather than `JSX.Element`: a child may be an async component. */
  children?: Children
  /** `primary` is filled; `quiet` is a link carrying the same padding. */
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
  size?: 'sm' | 'md' | 'icon'
  href?: string
  type?: 'button' | 'submit'
  name?: string
  value?: string
  disabled?: boolean
  class?: string
}

const base =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium ' +
  'whitespace-nowrap transition-colors outline-none ' +
  // The brand's one appearance outside the mark. A ring is a graphic, which is
  // the contrast bracket this red actually clears — see resources/css/app.css.
  'focus-visible:ring-[3px] focus-visible:ring-brand/40 ' +
  'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'

const variants = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'border border-border bg-background hover:bg-accent hover:text-accent-foreground',
  quiet: 'hover:bg-accent hover:text-accent-foreground',
  danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
}

const sizes = { sm: 'h-8 px-3', md: 'h-9 px-4', icon: 'size-9' }

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
