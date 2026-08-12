import { Elysia } from 'elysia'
import ArticleController from '../app/Http/Controllers/ArticleController.ts'
import CacheController from '../app/Http/Controllers/CacheController.ts'
import CheckController from '../app/Http/Controllers/CheckController.ts'
import ExerciseController from '../app/Http/Controllers/ExerciseController.ts'
import GuardController from '../app/Http/Controllers/GuardController.ts'
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
  .use(ArticleController)
  .use(GuardController)
  .use(CacheController)
