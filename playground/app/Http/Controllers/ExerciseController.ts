import { config, controller, NotFoundException } from '@elysian/core'
import { Arr, collect, Str } from '@elysian/support'
import { render, view } from '@elysian/view'
import { DelayedGreeting, Exercise } from '../../../resources/views/pages/exercise.tsx'

/**
 * Deliberate exercise surface for `bun run smoke`.
 *
 * Every route here covers a framework seam that would otherwise only be checked
 * by hand: typed view rendering, raw string rendering, async components, XSS
 * escaping via `safe`, the support helpers, the `config()` helper, and both
 * error paths through the exception handler.
 *
 * Note this file is `.ts`, not `.tsx` — components are plain functions, so no
 * JSX syntax is needed to render them.
 *
 * Keep this file in sync with `scripts/smoke.ts` — the assertions live there.
 */
export default controller('exercise', '/exercise')
  .get('/view', () =>
    view(Exercise, {
      title: 'Exercise',
      items: ['alpha', 'beta', 'gamma'],
      untrusted: '<script>alert(1)</script>'
    })
  )
  .get('/render', async () => ({
    html: await render(Exercise, { title: 'Raw', items: ['one'], untrusted: 'x' })
  }))
  .get('/async', () => view(DelayedGreeting, { name: 'Elysian' }))
  .get('/support', () => ({
    studly: Str.studly('send_reports'),
    plural: Str.plural('category'),
    slug: Str.slug('Héllo World!'),
    dot: Arr.get<string>({ a: { b: { c: 'deep' } } }, 'a.b.c'),
    collection: collect([3, 1, 2])
      .sortBy((value) => value)
      .map((value) => value * 2)
      .all()
  }))
  .get('/config', () => ({
    name: config<string>('app.name'),
    missing: config('nope.nothing', 'fallback')
  }))
  .get('/not-found', () => {
    throw new NotFoundException('Deliberately missing')
  })
  .get('/boom', () => {
    throw new Error('deliberate failure')
  })
