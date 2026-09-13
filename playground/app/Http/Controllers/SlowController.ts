import { can } from '@elvel/auth'
import { cache } from '@elvel/cache'
import { app, dump } from '@elvel/core'
import { db } from '@elvel/database'
import { http } from '@elvel/http-client'
import { log } from '@elvel/log'
import { mailTo } from '@elvel/mail'
import { notify, route } from '@elvel/notifications'
import { dispatch, queue } from '@elvel/queue'
import { view } from '@elvel/view'
import { Elysia } from 'elysia'
import { Slow } from '../../../resources/views/pages/slow.tsx'
import { ImportRow } from '../../Jobs/ImportRow.ts'
import { TouchArticle } from '../../Jobs/TouchArticle.ts'
import { ArticlePublished as ArticleMail } from '../../Mail/ArticlePublished.ts'
import { Article } from '../../Models/Article.ts'
import { ArticlePublished } from '../../Notifications/ArticlePublished.ts'

/**
 * One page that exercises every watcher an HTTP request can reach.
 *
 * The Lens bar has a menu per entry type, and a menu with nothing behind it
 * teaches nobody what the tool does. This fills all of them in one page, and
 * fills several of them *badly* on purpose — an N+1, a cache that never hits, a
 * swallowed exception — so the findings have something to find.
 *
 * `command` and `schedule` are missing and cannot be here: a console command
 * and a scheduled task run in their own processes, which is the whole reason
 * the bar reaches for storage to show them.
 *
 * Not an example to copy. Most of this is the wrong way round.
 */
export default new Elysia({ name: 'slow' }).get('/slow', async ({ request }) => {
  const articles = await Article.query().take(8).get()
  const titles: string[] = []

  /**
   * The N+1: one query per row, in a loop, as it happens in real code when a
   * relation is read inside a map.
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

  /** A model touched, so the model watcher has an action to record. */
  const first = articles.all()[0]

  if (first !== undefined) {
    first.setAttribute('editor_note', `seen at ${new Date().toISOString()}`)
    await first.save()
  }

  /** An authorisation check, whatever it answers. */
  await can('view-status-page')

  /** An outgoing call, to ourselves — the one upstream always reachable here. */
  const origin = new URL(request.url).origin

  await http().acceptJson().get(`${origin}/check/client/upstream/ok`)

  /** Mail, through the array mailer, so nothing leaves the machine. */
  if (first !== undefined) {
    await mailTo('ada@example.com').send(
      new ArticleMail({
        title: String(first.getAttribute('title')),
        excerpt: 'Everything on this page is wrong on purpose.',
        articleId: Number(first.getAttribute('id'))
      })
    )

    await notify(
      route('mail', 'ada@example.com'),
      new ArticlePublished({
        title: String(first.getAttribute('title')),
        articleId: Number(first.getAttribute('id'))
      })
    )
  }

  /** A job and a batch, queued but never worked here. */
  if (first !== undefined) {
    await dispatch(new TouchArticle({ article: first, suffix: 'slow' }))
  }

  await queue()
    .batch([new ImportRow({ row: 1 }), new ImportRow({ row: 2 })])
    .name('slow page')
    .dispatch()

  /** Debugging left in, which the bar reports as a finding of its own. */
  dump({ articles: articles.all().length })

  /**
   * Something threw, something caught it, and the page still answers 200.
   *
   * Reported as well as logged, because that is what real code does with an
   * error it decides not to fail on, and reporting is what the exception
   * watcher listens for.
   */
  try {
    throw new TypeError('the editor note could not be decrypted')
  } catch (error) {
    app().make('exception.handler').report(error)
    log().error(`swallowed: ${(error as Error).message}`)
  }

  return view(Slow, { titles })
})
