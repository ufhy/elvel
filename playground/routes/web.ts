import { Elysia } from 'elysia'
import ArticleController from '../app/Http/Controllers/ArticleController.ts'
import CacheController from '../app/Http/Controllers/CacheController.ts'
import CheckController from '../app/Http/Controllers/CheckController.ts'
import ExerciseController from '../app/Http/Controllers/ExerciseController.ts'
import FileController from '../app/Http/Controllers/FileController.ts'
import GuardController from '../app/Http/Controllers/GuardController.ts'
import MailController from '../app/Http/Controllers/MailController.ts'
import NotificationController from '../app/Http/Controllers/NotificationController.ts'
import PageController from '../app/Http/Controllers/PageController.ts'
import QueueController from '../app/Http/Controllers/QueueController.ts'
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
  .use(QueueController)
  .use(MailController)
  .use(FileController)
  .use(NotificationController)
