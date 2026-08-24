import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

/**
 * One chunk per page, loaded when somebody goes there.
 *
 * Every `component` here is a function returning `import()`, and that is the only
 * thing that makes the split happen: Rollup follows a dynamic import into its own
 * file and a static one into the entry. Nothing about it is a build setting.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/dashboard' },

  /**
   * The auth screens, which the server also has routes for.
   *
   * Both halves are needed and neither is redundant: the server's `/sign-in`
   * answers the *document* — guarded by `middleware('guest')`, so a signed-in
   * visitor never reaches it — and this entry is what renders inside that document,
   * and what a client-side link navigates to without a page load.
   */
  { path: '/sign-in', component: () => import('./views/auth/SignIn.vue') },
  { path: '/sign-up', component: () => import('./views/auth/SignUp.vue') },
  { path: '/forgot-password', component: () => import('./views/auth/ForgotPassword.vue') },
  { path: '/reset-password', component: () => import('./views/auth/ResetPassword.vue') },
  { path: '/confirm-password', component: () => import('./views/auth/ConfirmPassword.vue') },
  { path: '/verify-email', component: () => import('./views/auth/VerifyEmail.vue') },
  {
    path: '/two-factor-challenge',
    component: () => import('./views/auth/TwoFactorChallenge.vue')
  },

  /**
   * Settings. Five of the six are rendered from a document the server built —
   * sessions, passkeys, an enrolment in progress — so `SettingsLayout` links to
   * them with plain anchors. The routes are here because the document still needs
   * this router to know which component to mount at that address.
   */
  { path: '/settings/profile', component: () => import('./views/settings/Profile.vue') },
  { path: '/settings/password', component: () => import('./views/settings/Password.vue') },
  { path: '/settings/two-factor', component: () => import('./views/settings/TwoFactor.vue') },
  { path: '/settings/passkeys', component: () => import('./views/settings/Passkeys.vue') },
  { path: '/settings/security', component: () => import('./views/settings/Security.vue') },
  {
    path: '/settings/appearance',
    component: () => import('./views/settings/Appearance.vue'),
    // The only settings page with no server route behind it, so it is the only one
    // whose title nothing else sets.
    meta: { title: 'Appearance' }
  },

  {
    path: '/dashboard',
    name: 'dashboard',
    component: () => import('./views/Dashboard.vue'),
    meta: { title: 'Dashboard' }
  },

  /**
   * A page for an address nothing matched — the client's own 404.
   *
   * The server answers every unknown path with the document, because it cannot
   * know which paths this router owns. So the router has to be the one to say "no
   * such page", and it needs a page to say it with.
   */
  { path: '/:rest(.*)', name: 'missing', component: () => import('./views/Missing.vue') }
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

/**
 * The tab's title, after a navigation that fetched no document.
 *
 * The server sets `<title>` on the document it renders, and that is right for the
 * page it rendered — but a client-side navigation replaces the view and nothing
 * else, so the title stayed on whatever the document said. Signing in and landing
 * on the dashboard left the tab reading "Sign in".
 *
 * Only routes that declare one are touched. The auth screens deliberately do not:
 * each is reached by a document load, so the server's title is already correct and
 * repeating it here would be two places to change it.
 */
router.afterEach((to) => {
  const title = to.meta.title

  if (typeof title === 'string') document.title = title
})
