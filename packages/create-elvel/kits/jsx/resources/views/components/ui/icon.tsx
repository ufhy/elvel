import { classes } from '@elvel/view'

/**
 * The icons these pages use, inline.
 *
 * Laravel's kits import `lucide-react` and reach for a component per icon; a
 * server-rendered page has no component to hydrate, so an icon here is a string
 * of SVG and a dependency would only be a way to ship several hundred of them to
 * find eleven. These are the same drawings, taken from Lucide, and they inherit
 * `currentColor` — which is why none of them mentions a colour.
 *
 * Add one by pasting its paths from lucide.dev.
 */
const paths: Record<string, string> = {
  'layout-grid':
    '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/>' +
    '<rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',

  'book-open-text':
    '<path d="M12 5v16"/><path d="M16 13h2"/><path d="M16 9h2"/>' +
    '<path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"/>' +
    '<path d="M6 13h2"/><path d="M6 9h2"/>',

  'folder-git-2':
    '<path d="M18 19a5 5 0 0 1-5-5v8"/>' +
    '<path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5"/>' +
    '<circle cx="13" cy="12" r="2"/><circle cx="20" cy="19" r="2"/>',

  'chevrons-up-down': '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',

  'chevron-right': '<path d="m9 18 6-6-6-6"/>',

  menu: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',

  'log-out':
    '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>' +
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',

  settings:
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>' +
    '<circle cx="12" cy="12" r="3"/>',

  sun:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/>' +
    '<path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/>' +
    '<path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',

  moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',

  monitor:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/>' +
    '<line x1="12" x2="12" y1="17" y2="21"/>'
}

export type IconName = keyof typeof paths

export function Icon({ name, class: extra }: { name: IconName; class?: string }) {
  return (
    <svg
      class={classes('size-4 shrink-0', extra)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? ''}
    </svg>
  )
}
