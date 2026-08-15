import { whenAuth, whenCan, whenGuest } from '@elysian/auth'
import { whenError } from '@elysian/http'
import { once, prepend, push, pushOnce } from '@elysian/view'
import { Layout } from '../components/layout.tsx'

export type ViewHelpersProps = {
  title: string
  /** Rendered by `whenCan`, so the ability has to be awaited before the tree. */
  editable: string
}

/**
 * The six things Blade has that JSX did not — as functions rather than directives.
 *
 * Blade's `@error`, `@auth`, `@guest`, `@can`, `@once` and `@push`/`@stack` all
 * read something the page cannot see from its props: the last request's failures,
 * the signed-in user, the Gate, and a layout further up the tree. Each one lives
 * in the package that owns what it reads — `whenError` in `@elysian/http` beside
 * `errors()` and `old()`, `whenAuth` in `@elysian/auth` beside `user()` — which
 * is where `csrfField` already was.
 *
 * The callback shape is deliberate. `{errors().first('email') ? <p>{...}</p>
 * : null}` reads the bag twice and will one day check one field and print
 * another; `whenError` hands the message to the branch that prints it.
 */
export function ViewHelpers({ title, editable }: ViewHelpersProps) {
  return (
    <Layout title={title}>
      {/* Into the layout's `<head>`, which rendered before this line ran. */}
      {push('head', '<meta name="pushed-by" content="view-helpers" />')}
      {prepend('head', '<meta name="prepended" content="first" />')}
      {push('scripts', '<script id="tail">/* end of body */</script>')}

      <h1 safe>{title}</h1>

      <section id="error">
        <h2>whenError</h2>
        {whenError('email', (message) => `<p class="error">${message}</p>`) ||
          '<p class="quiet">No error flashed.</p>'}
      </section>

      <section id="auth">
        <h2>whenAuth and whenGuest</h2>
        {whenAuth((user) => `<p>Signed in as ${user.email}</p>`)}
        {whenGuest(() => '<p class="quiet">Nobody is signed in.</p>')}
      </section>

      <section id="can">
        <h2>whenCan</h2>
        {editable}
      </section>

      <section id="once">
        <h2>once</h2>
        {/* Three widgets, one copy of the style. */}
        {widget()}
        {widget()}
        {widget()}
      </section>
    </Layout>
  )
}

/**
 * A component that needs one copy of something however often it appears.
 *
 * `once` is the answer to "this needs a style tag and I do not know how many of
 * me are on the page"; `pushOnce` sends that one copy to the head instead of
 * leaving it inline.
 */
function widget(): string {
  return (
    pushOnce('head', 'widget-style', '<style id="widget-style">.widget{}</style>') +
    once('widget-note', '<!-- widget note, once -->') +
    '<div class="widget">widget</div>'
  )
}

/** Awaited outside the tree, because the Gate may read the database. */
export async function editableMarkup(): Promise<string> {
  return (
    (await whenCan('view-status-page', [], () => '<p id="allowed">You may edit this.</p>')) ||
    '<p class="quiet">Not allowed.</p>'
  )
}
