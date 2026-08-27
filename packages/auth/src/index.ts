export {
  type Dialect,
  diffMigrationFor,
  type ElvelAdapterOptions,
  elvelAdapter,
  migrationFor,
  schemaShape
} from './adapter.ts'
export { AuthSchemaCommand } from './console/auth-schema.ts'
export { AuthSecretCommand } from './console/auth-secret.ts'
export { MakePolicyCommand } from './console/make-policy.ts'
export {
  type AbilityCallback,
  type AbilityOptions,
  type AbilityResult,
  type AuthUser,
  Gate
} from './gate.ts'
export {
  auth,
  authorize,
  can,
  cannot,
  gate,
  maybeUserOf,
  requireUser,
  session,
  user,
  userOf,
  whenAuth,
  whenCan,
  whenCannot,
  whenGuest
} from './helpers.ts'
export { authMailHooks, type MailHookOptions, type Notifier, withAuthMail } from './mail-hooks.ts'
export { type AuthInstance, AuthManager, type AuthSession } from './manager.ts'
/**
 * The middleware are registered as aliases by the provider, so a route names them
 * as strings and rarely imports one. `confirmPassword` is the exception: it is
 * what *opens* the window `password.confirm` guards, and without it the alias is a
 * door that only locks.
 */
export {
  authenticate,
  canAccess,
  confirmPassword,
  ensureVerified,
  guestOnly,
  PASSWORD_CONFIRMED_AT,
  type RedirectTarget,
  requirePassword
} from './middleware.ts'
export {
  type AuthMailData,
  ChangeEmailNotification,
  PasswordChangedNotification,
  ResetPasswordNotification,
  VerifyEmailNotification
} from './notifications.ts'
export { Policy, type PolicyLike, type PolicyResult, policyAllowsGuests } from './policy.ts'
export { type AuthConfig, AuthServiceProvider } from './provider.ts'
export { AuthorizationError, AuthorizationResponse } from './response.ts'
export {
  type AuthProblem,
  api,
  messageFrom,
  problemFrom,
  type SessionSummary,
  sessionSummaries,
  withSession
} from './responses.ts'
export type { AuthApi, AuthTypes, CurrentUser } from './types.ts'
