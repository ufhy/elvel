import { controller } from '@elysian/core'
import { redirect } from '@elysian/http'
import { view } from '@elysian/view'
import { t } from 'elysia'
import { editableMarkup, ViewHelpers } from '../../../resources/views/pages/view-helpers.tsx'

/**
 * The six view helpers, over HTTP.
 *
 * Each of them reads something a prop cannot carry — the last request's errors,
 * the signed-in user, the Gate, a layout further up the tree — so a unit test on
 * the component proves less than a request does. The POST below fails validation
 * on purpose so the next GET has a flashed error for `whenError` to find, which
 * is the only way to exercise it end to end.
 */
export default controller('view-helpers')
  .get('/check/view-helpers', async () =>
    view(ViewHelpers, { title: 'View helpers', editable: await editableMarkup() })
  )

  .post(
    '/check/view-helpers/fail',
    ({ body }) =>
      redirect('/check/view-helpers')
        .withErrors({ email: 'That address was not accepted.' })
        .withInput({ email: body.email })
        .toResponse(),
    { body: t.Object({ email: t.String() }) }
  )
