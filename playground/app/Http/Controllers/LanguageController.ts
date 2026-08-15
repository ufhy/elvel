import { controller } from '@elysian/core'
import { __, choice, trans } from '@elysian/translation'

/**
 * Generated with `bun run playground make:controller LanguageController`, then
 * extended.
 *
 * Every shape a translation comes in, read back over the network: a dotted key
 * from `lang/<locale>/orders.ts`, a whole sentence from `lang/<locale>.json`, a
 * plural chosen by count, and a key nobody has translated.
 *
 * The locale is switched per request and restored afterwards, which is the part
 * worth exercising here rather than in a unit test: one process serves everybody,
 * and a locale left set would answer the next request in the last one's language.
 */
export default controller('language').get('/check/lang/:locale', ({ params, query }) => {
  const previous = trans().getLocale()
  const count = Number(query.count ?? 2)

  trans().setLocale(params.locale)

  try {
    return {
      locale: trans().getLocale(),
      // A dotted key, from lang/<locale>/orders.ts.
      title: __('orders.title'),
      // The same key with a replacement, matching case as Laravel does.
      greeting: __('orders.greeting', { name: 'ada' }),
      // Chosen by count; `:count` is filled in without being passed twice.
      count: choice('orders.count', count),
      // A whole sentence, keyed by itself, from lang/<locale>.json.
      sentence: __('You have no orders yet.'),
      // Nothing translated it anywhere: the key comes back, which is obviously
      // wrong on the page and obviously fixable.
      missing: __('orders.nowhere'),
      // English only, so a half-translated locale falls back rather than
      // showing a raw key.
      fallback: __('orders.fallback_only')
    }
  } finally {
    trans().setLocale(previous)
  }
})
