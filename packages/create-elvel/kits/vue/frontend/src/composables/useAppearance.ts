import { onMounted, ref } from 'vue'

export type Appearance = 'light' | 'dark' | 'system'

const KEY = 'appearance'

/** Light, dark, or whatever the operating system currently says. */
function resolve(choice: Appearance): boolean {
  if (choice === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }

  return choice === 'dark'
}

/**
 * The `.dark` class the stylesheet keys off — `@custom-variant dark (&:is(.dark *))`.
 */
function paint(choice: Appearance): void {
  document.documentElement.classList.toggle('dark', resolve(choice))
}

function stored(): Appearance {
  try {
    const found = localStorage.getItem(KEY)

    return found === 'light' || found === 'dark' || found === 'system' ? found : 'system'
  } catch {
    // A browser with site data blocked answers by throwing. "system" is a fine
    // answer to that, and a crash is not.
    return 'system'
  }
}

/**
 * Apply the stored choice. Called from `main.ts`, before the app mounts.
 *
 * **There is a flash of the wrong theme on the first paint**, and it is honest to
 * say so: the stylesheet lands before this module runs, so a browser set to dark
 * with `system` chosen will paint light for a frame. The server-rendered kit avoids
 * it with an inline script carrying the request's CSP nonce; `shell.tsx` has no way
 * to name a nonce yet, and faking one would mean opening `script-src` to inline
 * scripts — which is the hole the policy exists to close.
 */
export function applyStoredAppearance(): void {
  paint(stored())

  // A choice of "system" has to keep following the system, including a change made
  // while the page is open.
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => stored() === 'system' && paint('system'))
}

export function useAppearance() {
  const appearance = ref<Appearance>('system')

  onMounted(() => {
    appearance.value = stored()
  })

  const choose = (next: Appearance): void => {
    appearance.value = next
    paint(next)

    try {
      localStorage.setItem(KEY, next)
    } catch {
      // Nothing to do: the theme still applies for this page, it just will not be
      // remembered. Better than refusing to change it at all.
    }
  }

  return { appearance, choose }
}
