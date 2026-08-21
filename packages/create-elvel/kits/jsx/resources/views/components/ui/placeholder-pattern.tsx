import { classes } from '@elvel/view'

/**
 * The hatched box that stands in for a chart you have not built yet.
 *
 * Laravel's kits open the dashboard with four of these, and the reason is a good
 * one: an empty dashboard that looks *deliberately* empty invites you to put
 * something there, where three cards of filler text read as the kit's opinion
 * about what belongs on the page.
 *
 * The pattern needs an id, and two on one page must not share it. React's
 * `useId` does that; here the caller passes a name, because a server render has
 * no hook to call and a name in the markup is easier to debug than a counter.
 */
export function PlaceholderPattern({ id, class: extra }: { id: string; class?: string }) {
  return (
    <svg class={classes('stroke-foreground/20', extra)} fill="none" aria-hidden="true">
      <defs>
        <pattern id={id} x="0" y="0" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M-3 13 15-5M-5 5l18-18M-1 21 17 3" />
        </pattern>
      </defs>
      <rect stroke="none" fill={`url(#${id})`} width="100%" height="100%" />
    </svg>
  )
}
