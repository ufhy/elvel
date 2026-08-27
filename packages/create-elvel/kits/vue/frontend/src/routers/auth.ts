import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

/**
 * The auth bundle's router — the only place these five addresses are written.
 *
 * The server knows one route for all of them: `Route.view('/{path}', …)` under the
 * `auth` prefix, guarded by `guest`. So it decides *whether you may be here* and
 * which bundle answers, and this decides *what renders* — with no list on the
 * server to keep in step.
 *
 * The prefix is in these paths rather than in the router's `history` base, because
 * the server's prefix is what it is: `/auth/sign-in` is the address, and a base
 * would hide that from anybody reading this file for it.
 *
 * `/verify-email` and `/confirm-password` are not here. Both are shown to somebody
 * already signed in, so they are in the application's bundle and its router —
 * `guest` would have bounced them out of this one.
 *
 * No catch-all. An address this bundle does not know is not a client-side 404 —
 * the server never sends this bundle for one. The application's router owns that.
 */
const routes: RouteRecordRaw[] = [
  { path: '/auth/sign-in', component: () => import('../views/auth/SignIn.vue') },
  { path: '/auth/sign-up', component: () => import('../views/auth/SignUp.vue') },
  { path: '/auth/forgot-password', component: () => import('../views/auth/ForgotPassword.vue') },
  { path: '/auth/reset-password', component: () => import('../views/auth/ResetPassword.vue') },
  {
    path: '/auth/two-factor-challenge',
    component: () => import('../views/auth/TwoFactorChallenge.vue')
  }
]

export const authRouter = createRouter({ history: createWebHistory(), routes })
