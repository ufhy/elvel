import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

/**
 * The auth bundle's router.
 *
 * Every one of these addresses is also a real server route, guarded by `guest` or
 * `auth`, and that is not a duplication: the server decides *whether you may be
 * here* and which bundle answers, and this decides *what renders* once that bundle
 * is running.
 *
 * No catch-all. An address this bundle does not know is not a client-side 404 —
 * the server never sends this bundle for one. The application's router owns that.
 */
const routes: RouteRecordRaw[] = [
  { path: '/sign-in', component: () => import('../views/auth/SignIn.vue') },
  { path: '/sign-up', component: () => import('../views/auth/SignUp.vue') },
  { path: '/forgot-password', component: () => import('../views/auth/ForgotPassword.vue') },
  { path: '/reset-password', component: () => import('../views/auth/ResetPassword.vue') },
  { path: '/confirm-password', component: () => import('../views/auth/ConfirmPassword.vue') },
  { path: '/verify-email', component: () => import('../views/auth/VerifyEmail.vue') },
  {
    path: '/two-factor-challenge',
    component: () => import('../views/auth/TwoFactorChallenge.vue')
  }
]

export const authRouter = createRouter({ history: createWebHistory(), routes })
