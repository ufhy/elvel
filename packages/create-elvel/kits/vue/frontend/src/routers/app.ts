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
   * Settings. Five of the six are rendered from a document the server built —
   * sessions, passkeys, an enrolment in progress — so `SettingsLayout` links to
   * them with plain anchors. The routes are here because the document still needs
   * this router to know which component to mount at that address.
   */
  {
    path: '/settings/profile',
    component: () => import('../views/settings/Profile.vue'),
    meta: { title: 'Profile' }
  },
  {
    path: '/settings/password',
    component: () => import('../views/settings/Password.vue'),
    meta: { title: 'Password' }
  },
  {
    path: '/settings/two-factor',
    component: () => import('../views/settings/TwoFactor.vue'),
    meta: { title: 'Two-factor' }
  },
  {
    path: '/settings/passkeys',
    component: () => import('../views/settings/Passkeys.vue'),
    meta: { title: 'Passkeys' }
  },
  {
    path: '/settings/security',
    component: () => import('../views/settings/Security.vue'),
    meta: { title: 'Security' }
  },
  {
    path: '/settings/appearance',
    component: () => import('../views/settings/Appearance.vue'),
    // The only settings page with no server route behind it, so it is the only one
    // whose title nothing else sets.
    meta: { title: 'Appearance' }
  },

  /**
   * The two auth screens that are not in the auth bundle.
   *
   * Both are for somebody already signed in — one confirms an address, the other a
   * password — so the server keeps them in this half, behind `auth`, and the guest
   * prefix would have turned their visitor away. The components live under
   * `views/auth/` because that is what they are about; which bundle they ship in is
   * decided here.
   */
  {
    path: '/verify-email',
    component: () => import('../views/auth/VerifyEmail.vue'),
    meta: { title: 'Verify your email' }
  },
  {
    path: '/confirm-password',
    component: () => import('../views/auth/ConfirmPassword.vue'),
    meta: { title: 'Confirm your password' }
  },

  {
    path: '/dashboard',
    name: 'dashboard',
    component: () => import('../views/Dashboard.vue'),
    meta: { title: 'Dashboard' }
  },

  /**
   * A page for an address nothing matched — the client's own 404.
   *
   * The server answers every unknown path with the document, because it cannot
   * know which paths this router owns. So the router has to be the one to say "no
   * such page", and it needs a page to say it with.
   */
  {
    path: '/:rest(.*)',
    name: 'missing',
    component: () => import('../views/Missing.vue'),
    /**
     * The one route that has to name itself.
     *
     * An unknown address is answered by the exception handler, which has no call
     * site to pass a title through — so the document arrives without one and the tab
     * shows the URL until this replaces it.
     */
    meta: { title: 'No such page' }
  }
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
