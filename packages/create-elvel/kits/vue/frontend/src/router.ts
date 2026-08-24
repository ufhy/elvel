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
  { path: '/dashboard', name: 'dashboard', component: () => import('./views/Dashboard.vue') },

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
