import { cache } from '@elvel/cache'
import { app } from '@elvel/core'
import { db } from '@elvel/database'
import { log } from '@elvel/log'
import { view } from '@elvel/view'
import { Elysia } from 'elysia'
import { Slow } from '../../../resources/views/pages/slow.tsx'
import { Article } from '../../Models/Article.ts'

/**
 * A page written badly on purpose.
 *
 * The playground has no slow page and no broken one, which made the Lens bar
 * look useless: an inspector with nothing to find says nothing, whatever it is
 * capable of. This is the fixture that proves each finding fires — an N+1, a
 * slow query, a swallowed exception, an error log and a cache that never hits.
 *
 * Not an example to copy. Every line here is the wrong way round.
 */
export default new Elysia({ name: 'slow' }).get('/slow', async () => {
  const articles = await Article.query().take(8).get()
  const titles: string[] = []

  /**
   * The N+1: one query per row, in a loop, exactly as it happens in real code
   * when a relation is read inside a map.
   */
  for (const article of articles.all()) {
    const rows = await (await db().connection()).select<{ n: number }>(
      'select count(*) as n from comments where article_id = ?',
      [article.getAttribute('id')]
    )

    titles.push(`${String(article.getAttribute('title'))} — ${String(rows[0]?.n ?? 0)} comments`)
  }

  /** A cache nothing ever writes, looked up twice. */
  await cache().get('slow:never-written')
  await cache().get('slow:never-written')

  /**
   * Something threw, something caught it, and the page will still answer 200.
   *
   * Reported as well as logged, because that is what real code does with an
   * error it decides not to fail on — and reporting is what puts it in front of
   * the exception watcher.
   */
  try {
    throw new TypeError('the editor note could not be decrypted')
  } catch (error) {
    app().make('exception.handler').report(error)
    log().error(`swallowed: ${(error as Error).message}`)
  }

  return view(Slow, { titles })
})
