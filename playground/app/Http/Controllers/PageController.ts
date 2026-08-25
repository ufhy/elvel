import { view } from '@elvel/view'
import { Elysia } from 'elysia'
import { Landing } from '../../../resources/views/pages/landing.tsx'

/**
 * A controller is an Elysia instance, which is what keeps the request context
 * fully typed inside handlers. The name drives Elysia's plugin deduplication.
 *
 * This file stays `.ts`: components are plain functions, so no JSX syntax is
 * needed here. Rename it to `.tsx` if you would rather write markup inline.
 */
export default new Elysia({ name: 'page' })
  .get('/', () => view(Landing, { title: 'Welcome' }))
  .get('/health', () => ({ status: 'ok' }))
