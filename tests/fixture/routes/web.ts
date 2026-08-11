import { controller, NotFoundException } from '@elysian/core'
import { render, view } from '@elysian/view'
import { Bare, Hello } from '../resources/views/pages/hello.tsx'

export default controller('fixture:page')
  .get('/', () => view(Hello, { title: 'Greeting', who: 'World', items: ['a', 'b'] }))
  .get('/escaped', () => view(Hello, { title: 'Greeting', who: '<b>x</b>', items: [] }))
  .get('/bare', () => view(Bare))
  .get('/string', async () => ({ html: await render(Bare) }))
  .get('/json', () => ({ ok: true }))
  .get('/boom', () => {
    throw new NotFoundException('No such thing')
  })
  .get('/explode', () => {
    throw new Error('kaboom')
  })
