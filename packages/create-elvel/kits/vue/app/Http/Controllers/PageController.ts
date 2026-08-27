/**
 * What the server answers for itself, which here is one thing.
 *
 * The template's version of this file also renders the landing page, and that page
 * has no owner in this kit: `routes/web.ts` hands `/` to `routes/view.ts` because
 * the Vue router owns it — `frontend/src/routers/app.ts` — and one address cannot
 * have two. With `index()` unrouted, the 416-line `welcome.tsx` it rendered and the
 * `layout.tsx` behind it were unreachable, so this kit's manifest drops both.
 *
 * `/health` is what is left, and it is not a page. A load balancer asking wants a
 * status code, not JavaScript, and it has to answer before any bundle is built —
 * which is why it stays an exact route rather than falling to the view.
 */
export default class PageController {
  health() {
    return { status: 'ok' }
  }
}
