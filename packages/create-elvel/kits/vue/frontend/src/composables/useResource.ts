import { onMounted, ref } from 'vue'
import { Unauthenticated } from '@/api.ts'
import { confirmed } from '@/composables/usePasswordConfirm.ts'

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
 *
 * A 423 is not one either, and it is not handled here: `confirmed` asks for the
 * password in a dialog and loads again. What reaches the `catch` is either a real
 * failure or a wall somebody dismissed, and both belong in `failed`.
 */
export function useResource<T>(load: () => Promise<T>) {
  const data = ref<T | null>(null)
  const failed = ref('')

  const reload = async (): Promise<void> => {
    failed.value = ''

    try {
      data.value = await confirmed(load)
    } catch (problem) {
      if (problem instanceof Unauthenticated) {
        window.location.assign('/auth/sign-in')

        return
      }

      failed.value = problem instanceof Error ? problem.message : 'That did not load.'
    }
  }

  onMounted(reload)

  return { data, failed, reload }
}
