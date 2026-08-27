import { ref } from 'vue'
import { NeedsPasswordConfirmation } from '@/api.ts'

/**
 * The password wall, asked for in place rather than navigated to.
 *
 * `password.confirm` guards the endpoints behind the security screens, and a
 * request that hits it comes back `423`. The first version of this reloaded the
 * document, because the *page* routes carried the same guard and the server would
 * redirect. There is one view route now — it answers every address, including the
 * confirmation screen — so reloading was a loop: same shell, same request, same
 * 423. Measured, the two-factor screen reloaded forever.
 *
 * Laravel's own Vue starter kit keeps `ConfirmPassword` a full page, and it is
 * right to: Inertia navigates documents, so the server's redirect lands as one.
 * Nothing here navigates — the client already catches the 423 — so the wall can be
 * what it actually is: an interruption, not a destination. Nobody leaves the
 * screen, and nothing has to remember where they were.
 *
 * The work is re-run rather than resumed. A retried GET is the same GET, and a
 * retried write is the same write with the same token — the request never left
 * this function, so there is nothing to reconstruct.
 */
type Waiting = { resolve: () => void; reject: (problem: unknown) => void }

const open = ref(false)
let waiting: Waiting[] = []

/**
 * Run `work`, and if the server wants the password confirmed, ask and run it again.
 *
 * Everything that talks to a guarded endpoint goes through here — `useResource` for
 * reads and `useForm` for writes. A write reaching the wall used to throw with
 * nothing catching it, so a form simply did nothing: measured on "generate new
 * recovery codes" once the confirmation had timed out.
 */
export async function confirmed<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (problem) {
    if (!(problem instanceof NeedsPasswordConfirmation)) throw problem

    await asked()

    return await work()
  }
}

/**
 * Open the dialog, and answer when it is done.
 *
 * Everyone waiting shares one dialog and one confirmation. Two panels loading at
 * once behind the same wall is the ordinary case — the security screen reads
 * sessions and passkeys together — and two stacked dialogs asking the same
 * question would be a bug somebody reports as "it asked me twice".
 */
function asked(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    waiting.push({ resolve, reject })
    open.value = true
  })
}

/** The dialog's own handle on all of this. */
export function usePasswordConfirm() {
  const settle = (how: 'resolve' | 'reject') => {
    const held = waiting

    waiting = []
    open.value = false

    for (const one of held) {
      if (how === 'resolve') one.resolve()
      else one.reject(new NeedsPasswordConfirmation())
    }
  }

  return {
    open,
    /** The password was accepted: let every waiting request try again. */
    accepted: () => settle('resolve'),
    /**
     * Dismissed.
     *
     * The waiting requests are *rejected*, not left hanging: a caller that never
     * settles is a spinner that never stops, and the screen behind this has no way
     * to know the question was waved away.
     */
    dismissed: () => settle('reject')
  }
}
