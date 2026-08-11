import { controller } from '@elysian/core'
import { view } from '@elysian/view'

/**
 * A controller is an Elysia instance, which is what keeps the request context
 * fully typed inside handlers. The name drives Elysia's plugin deduplication.
 */
export default controller('page')
  .get('/', () =>
    view('pages.landing', {
      title: 'Welcome'
    })
  )
  .get('/health', () => ({ status: 'ok' }))
