import { Elysia } from 'elysia'
import CheckController from '../app/Http/Controllers/CheckController.ts'
import ExerciseController from '../app/Http/Controllers/ExerciseController.ts'
import PageController from '../app/Http/Controllers/PageController.ts'
import SignalController from '../app/Http/Controllers/SignalController.ts'

/**
 * Web routes. Mount controllers here — this file is the equivalent of
 * Laravel's `routes/web.php`.
 */
export default new Elysia({ name: 'routes:web' })
  .use(PageController)
  .use(ExerciseController)
  .use(SignalController)
  .use(CheckController)
