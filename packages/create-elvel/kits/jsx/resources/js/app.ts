/**
 * The application's JavaScript.
 *
 * A server-rendered application needs very little of this — the pages arrive as
 * HTML — so what is here is only what HTML cannot do by itself: remember an
 * appearance choice, and close a menu when you click away from it. Everything
 * else on these pages is a link, a form, or a `<details>` element.
 *
 * The *reading* of the appearance choice is not here: it happens in an inline
 * script in `components/layout.tsx`, because a module is deferred and would
 * paint a white page first. This file is the writing side.
 */

/**
 * Passkeys, which are the one thing on these pages that HTML cannot do.
 *
 * `navigator.credentials` is a browser API: the private key stays on the device
 * and only script on the page can ask it to sign. Imported rather than inlined
 * here so the auth kit underneath — which has no appearance setting — can ship
 * the same file and use it unchanged.
 */
import './passkeys.ts'

type Appearance = 'light' | 'dark' | 'system'

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

/** Put the choice on `<html>`, which is what `@custom-variant dark` looks at. */
function apply(appearance: Appearance): void {
  const dark = appearance === 'dark' || (appearance === 'system' && prefersDark())

  document.documentElement.classList.toggle('dark', dark)
}

function stored(): Appearance {
  try {
    const value = localStorage.getItem('appearance')

    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
  } catch {
    // A private window can refuse the read. "Follow the system" is the answer
    // that needs no storage to be right.
    return 'system'
  }
}

function choose(appearance: Appearance): void {
  try {
    localStorage.setItem('appearance', appearance)
  } catch {
    // Unstored, but still applied for this page — better than doing nothing
    // because the choice could not be remembered.
  }

  apply(appearance)
  mark(appearance)
}

/** Show which of the three buttons is the current one. */
function mark(appearance: Appearance): void {
  for (const button of document.querySelectorAll<HTMLElement>('[data-appearance]')) {
    const active = button.dataset.appearance === appearance

    button.setAttribute('aria-pressed', String(active))
    button.classList.toggle('bg-card', active)
    button.classList.toggle('shadow-xs', active)
    button.classList.toggle('text-foreground', active)
    button.classList.toggle('text-muted-foreground', !active)
  }
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null
  const button = target?.closest<HTMLElement>('[data-appearance]')

  if (button?.dataset.appearance) {
    choose(button.dataset.appearance as Appearance)

    return
  }

  /**
   * Close any open menu the click landed outside of.
   *
   * `<details>` gives a dropdown its open state, its keyboard behaviour and its
   * focus handling for free; the one thing it will not do is close when you
   * click elsewhere, because nothing told it the page moved on. This is that.
   */
  for (const open of document.querySelectorAll<HTMLDetailsElement>('details[open]')) {
    if (!open.contains(target)) open.open = false
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return

  for (const open of document.querySelectorAll<HTMLDetailsElement>('details[open]')) {
    open.open = false
  }
})

// A "system" reader who changes their operating system's theme while the page is
// open should see it change too, without a reload.
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => stored() === 'system' && apply('system'))

mark(stored())
