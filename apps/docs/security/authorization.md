# Authorization

Who may do what. Two ways in, exactly as Laravel has them: a **gate** for a
one-off ability, and a **policy** for a model's whole set.

```ts
import { can, gate } from '@elvel/auth'

// A gate — app/Providers/AppServiceProvider.ts
gate().define('admin-panel', (user) => user.admin === true)

await can('admin-panel')            // false, for a user who is not
```

```ts
// A policy — app/Policies/ArticlePolicy.ts
import { Policy } from '@elvel/auth'

export class ArticlePolicy extends Policy<Article> {
  view(_user: User | null, article: Article) {
    return article.published
  }

  update(user: User, article: Article) {
    return article.user_id === user.id
  }
}
```

`bun elvel make:policy ArticlePolicy` writes one.

## Asking

```ts
await gate().allows('update', article)   // true
await gate().denies('update', article)   // the inverse

await gate().check(['view', 'update'], article)   // all of them
await gate().any(['delete', 'view'], article)     // at least one
await gate().none(['update'], article)            // not one of them
```

Run against a policy where Ada owns article 10 and Bob owns 11:

```
ada updates her own      → true
ada updates another's    → false
check ['view','update']  → true
any ['delete','view']    → true
undefined ability        → false
```

That last line is a decision: **an ability nobody defined denies rather than
throwing.** A typo in an ability name fails closed, which is the safe direction —
the alternative hands access to whoever misspells it.

## When a boolean is not enough

```ts
delete(user: User, article: Article) {
  return article.user_id === user.id
    ? true
    : AuthorizationResponse.deny('Only the author may delete this.')
}
```

```ts
const outcome = await gate().inspect('delete', theirs)

outcome.allowed()   // false
outcome.message     // 'Only the author may delete this.'
```

Note `message` is a **property**, not a method — `outcome.message()` fails with
`message is not a function`.

`AuthorizationResponse` also carries a status:

```ts
AuthorizationResponse.denyWithStatus(409, 'Already published.')
AuthorizationResponse.denyAsNotFound()
```

`denyAsNotFound` exists because hiding a record's existence is often the point: a
403 on something the viewer may not see has already told them it is there.

## Throwing instead of asking

```ts
await gate().authorize('delete', article)   // AuthorizationError, status 403
```

`authorize` throws where `allows` answers, so a handler can state the rule as one
line and let the exception handler turn it into a response.

## Guests, and the one place TypeScript forces a difference

```ts
export class ArticlePolicy extends Policy<Article> {
  static override allowGuests = ['view']

  view(_user: User | null, article: Article) {
    return article.published
  }
}
```

```
guest views a published article  → true
guest views a draft              → false
guest updates                    → false   (update is not in allowGuests)
```

Laravel decides this from the **reflected type** of the `$user` parameter: a
nullable type means the ability may run for a guest. TypeScript erases that type
and nothing puts it back, so an ability reachable without a user has to say so by
name. `allowGuests = true` allows every ability in the policy.

This is one of the few places the port could not follow Laravel exactly, and the
reason is the same one that rules out facades — see
[the packages page](/architecture/packages).

## `before` and `after`

```ts
export class ArticlePolicy extends Policy<Article> {
  override before(user: User) {
    if (user.admin) return true      // an admin override, in one place
  }
}
```

An **instance** method, not a static one — `allowGuests` is the static, `before`
is not.

`gate().before()` and `gate().after()` do the same globally. A `before` that
returns anything other than `undefined` short-circuits the check — `undefined`
means "no opinion", which is what lets several of them coexist.

## Registering policies

```ts
gate().policy(Article, ArticlePolicy)
```

Or by name, which is what the scaffolded application does:

```ts
await gate().discoverPolicies(app.appPath('Policies'), models)
```

`ArticlePolicy` in that directory is registered for the model called `Article`,
resolved from the registry the application already keeps for queue payloads.
Laravel guesses the *namespace*; here the guess is the class name, which carries
the same meaning. **Explicit registration always wins** — a file that happens to
be called `ArticlePolicy` never overrides a `gate().policy(...)` you wrote.

`gate().resource('article', ArticlePolicy)` defines `article.viewAny`,
`article.view`, `article.create` and the rest against one policy, for abilities
not reached through a model instance.

## In a route

```ts
.get('/articles/:id/edit', handler, middleware('can:update'))
```

It calls `authorize`, so a refusal becomes an `AuthorizationError` and the
handler never runs. Anything after the ability is passed along as **plain
strings** — `can:update,article` hands the ability the literal `'article'`, not a
model. For a check against a loaded record, do it in the handler where the record
exists:

```ts
.get('/articles/:id/edit', async ({ params }) => {
  const article = await Article.findOrFail(params.id)

  await gate().authorize('update', article)

  return view(EditArticle, { article })
})
```

## In a view

```tsx
{(await can('update', article)) ? <a href={editUrl}>Edit</a> : null}
```

`can()` and `cannot()` read the current user. `gate().forUser(other)` answers for
somebody else — useful in an admin screen that shows what another account can
see.

## Auditing a decision

Every check dispatches `gate.evaluated` with the user, the ability, the arguments
and the result, so an audit log is a listener rather than a wrapper around every
call site. The [events page](/basics/events-and-logging) has listeners.
