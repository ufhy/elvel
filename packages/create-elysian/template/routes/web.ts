import { Elysia } from 'elysia'
import PageController from '../app/Http/Controllers/PageController.ts'

/**
 * Web routes. Mount controllers here — this file is the equivalent of
 * Laravel's `routes/web.php`.
 */
export default new Elysia({ name: 'routes:web' }).use(PageController)
