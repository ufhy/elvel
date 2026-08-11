import { controller, NotFoundException } from '@elysian/core'
import { view } from '@elysian/view'

export default controller('fixture:page')
  .get('/', () => view('pages.hello', { title: 'Greeting', who: 'World', items: ['a', 'b'] }))
  .get('/json', () => ({ ok: true }))
  .get('/boom', () => {
    throw new NotFoundException('No such thing')
  })
  .get('/explode', () => {
    throw new Error('kaboom')
  })
