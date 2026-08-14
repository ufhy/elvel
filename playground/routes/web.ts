import { Elysia } from 'elysia'
import ArticleController from '../app/Http/Controllers/ArticleController.ts'
import CacheController from '../app/Http/Controllers/CacheController.ts'
import CheckController from '../app/Http/Controllers/CheckController.ts'
import CookieController from '../app/Http/Controllers/CookieController.ts'
import ExerciseController from '../app/Http/Controllers/ExerciseController.ts'
import FileController from '../app/Http/Controllers/FileController.ts'
import GuardController from '../app/Http/Controllers/GuardController.ts'
import LimitController from '../app/Http/Controllers/LimitController.ts'
import MailController from '../app/Http/Controllers/MailController.ts'
import MiddlewareController from '../app/Http/Controllers/MiddlewareController.ts'
import NotificationController from '../app/Http/Controllers/NotificationController.ts'
import PageController from '../app/Http/Controllers/PageController.ts'
import QueueController from '../app/Http/Controllers/QueueController.ts'
import SecretController from '../app/Http/Controllers/SecretController.ts'
import SignalController from '../app/Http/Controllers/SignalController.ts'
import SubscribeController from '../app/Http/Controllers/SubscribeController.ts'

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
  .use(CookieController)
  .use(QueueController)
  .use(MailController)
  .use(FileController)
  .use(NotificationController)
  .use(SecretController)
  .use(LimitController)
  .use(MiddlewareController)
  .use(SubscribeController)
