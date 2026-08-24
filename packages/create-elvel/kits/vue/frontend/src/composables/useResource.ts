import { onMounted, ref } from 'vue'
import { NeedsPasswordConfirmation, Unauthenticated } from '@/api.ts'

/**
 * Something a page reads from the server, with the three states it really has.
 *
 * Loading, loaded, and failed — and a page that pretends there are only two shows
 * an empty list while the request is in flight, which reads as "you have none"
 * rather than "not yet". `data` stays `null` until there is an answer, so a template
 * can say which of the three it is.
 *
 * A 401 is not an error to display. The session expired while the page was open, and
 * the only useful response is to go where a signed-out visitor belongs — the server
 * will take it from there. Anything else is left for the caller to show.
 */
export function useResource<T>(load: () => Promise<T>) {
  const data = ref<T | null>(null)
  const failed = ref('')

  const reload = async (): Promise<void> => {
    failed.value = ''

    try {
      data.value = await load()
    } catch (problem) {
      if (problem instanceof Unauthenticated) {
        window.location.assign('/sign-in')

        return
      }

      /**
       * A 423 means the password needs confirming again, and the answer is to load
       * this same address as a document.
       *
       * Not a jump to the confirmation screen: the server has the same guard on the
       * document route, and answering it there redirects *and* remembers where this
       * person was going. Jumping there directly arrives without that, and sends
       * them somewhere else afterwards — measured, it landed on
       * `/settings/security` after being stopped on `/settings/passkeys`.
       */
      if (problem instanceof NeedsPasswordConfirmation) {
        window.location.assign(window.location.href)

        return
      }

      failed.value = problem instanceof Error ? problem.message : 'That did not load.'
    }
  }

  onMounted(reload)

  return { data, failed, reload }
}
