import { classes } from '@elvel/view'

/**
 * The Elvel mark, from `art/mark.svg`.
 *
 * Inline rather than an `<img>`: drawn in `currentColor` it follows whatever
 * colour its container sets — including into dark mode — without a second file
 * and without a request of its own.
 */
export function Mark({ class: extra }: { class?: string }) {
  return (
    <svg
      class={classes('size-5 shrink-0', extra)}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Elvel"
    >
      <title>Elvel</title>
      <circle
        cx="24"
        cy="24"
        r="13"
        fill="none"
        stroke="currentColor"
        stroke-width="5"
        stroke-linecap="round"
        stroke-dasharray="63 19"
        transform="rotate(28 24 24)"
      />
      <rect x="15" y="21.5" width="18" height="5" rx="2.5" fill="currentColor" />
    </svg>
  )
}
