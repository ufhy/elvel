# Localization

Message files under `lang/`, read once at boot.

```ts
import { __, choice, trans } from '@elvel/translation'

__('messages.welcome', { name: 'Ada' })   // 'Welcome, Ada'
```

## The file layout, and the part that surprises

```
lang/
  en/messages.ts     ← groups: TypeScript modules, not JSON
  id/messages.ts
  id.json            ← whole sentences: JSON
```

::: warning A group file is a module, not JSON
`lang/en/messages.json` is **not read**. Files inside a locale directory must be
`.ts` (or `.js`) with a default export; only `lang/<locale>.json` — the
whole-sentence file — is JSON. Laravel's equivalents are `messages.php` and
`en.json`, so the split is the same and the extension is not.
:::

```ts
// lang/en/messages.ts
export default {
  welcome: 'Welcome, :name',
  articles: { count: '{0} No articles|{1} One article|[2,*] :count articles' }
}
```

```json
// lang/id.json
{ "Save changes": "Simpan perubahan" }
```

Nested keys work: `__('messages.articles.count')`. A group file being a module
also means the values can be computed, and that a typo in the file is a compile
error rather than a silent `undefined`.

## Placeholders and locales

```ts
__('messages.welcome', { name: 'Ada' })   // 'Welcome, Ada'

app.make('translator').setLocale('id')
__('messages.welcome', { name: 'Ada' })   // 'Selamat datang, Ada'

__('Save changes')                        // 'Simpan perubahan' — from id.json
```

A key nothing translated **comes back as itself**:

```
__('messages.nothing')   → 'messages.nothing'
```

That is deliberate. The alternative — an empty string — turns a missing
translation into a missing sentence, and the key at least tells you which one.

`app.locale` and `app.fallbackLocale` in `config/app.ts` set the pair.

## Pluralisation

```ts
choice('messages.articles.count', 0, { count: '0' })   // 'No articles'
choice('messages.articles.count', 1, { count: '1' })   // 'One article'
choice('messages.articles.count', 5, { count: '5' })   // '5 articles'
```

`{0}`, `{1}` and `[2,*]` are Laravel's conditions, and `choose(line, count,
locale)` applies them to a line you already have:

```
choose('one|many', 1, 'en')   // 'one'
choose('one|many', 4, 'en')   // 'many'
```

::: tip `__()` does not choose
Reading a pluralised line with `__()` returns the **whole line**, conditions and
all — `'{0} No articles|{1} One article|[2,*] 3 articles'`. That is not a bug in
the line; it is the wrong function. `choice()` is what selects.
:::

The plural index is per language, so a locale with three plural forms gets three.

## Why files are read at boot

Message files are small, they do not change while the process runs, and reading
them per request would put a filesystem call inside every view render. A missing
`lang/` directory is the ordinary case for an application with one language, not
an error.

## Notifications pick the recipient's language

A notifiable with a `preferredLocale()` has the translator switched for the
duration of the send — see the
[notifications page](/digging-deeper/notifications#the-recipient-s-language). It
has to happen there: a notification is rendered long after the request that
caused it, often in a worker with no request at all.
