import { afterEach, beforeEach, describe, test as it } from 'bun:test'
import { type MailFake, mail, mailer, mailTo } from '@elysian/mail'
import '../bootstrap/app.ts'
import './database.ts'
import { ArticlePublished } from '../app/Mail/ArticlePublished.ts'

/**
 * Mail, faked — the shape every application's mail test has.
 *
 * `mail().fake()` swaps the transport for one that records, so nothing leaves
 * the process and the assertions read what would have gone out. `restore()` in
 * `afterEach` matters more than it looks: a fake left in place makes the *next*
 * test file send nothing and pass for the wrong reason.
 */
let fake: MailFake

const article = {
  title: 'Something was published',
  excerpt: 'A short summary of it.',
  articleId: 1
}

beforeEach(() => {
  fake = mail().fake()
})

afterEach(() => {
  mail().restore()
})

describe('sending', () => {
  it('records instead of sending, and says what went out', async () => {
    await mailTo('ada@example.com').send(new ArticlePublished(article))

    fake
      .assertSent('ArticlePublished')
      .assertHasTo('ada@example.com')
      .assertHasSubject('Published: Something was published')
      .assertHasReplyTo('editors@example.com')
      .assertHasTag('article')
      .assertHasMetadata('articleId', '1')
  })

  /**
   * The body, not merely the envelope.
   *
   * A mailable whose view throws or renders the wrong template still has the
   * right subject and the right recipient — this is the assertion that tells the
   * difference.
   */
  it('and what was in it', async () => {
    await mailTo('ada@example.com').send(new ArticlePublished(article))

    fake
      .assertSent('ArticlePublished')
      .assertSeeInHtml('Something was published')
      .assertSeeInText('A short summary of it.')
      .assertHasNoAttachments()
  })

  it('nothing sent is a thing to assert too', () => {
    fake.assertNothingSent()
    fake.assertNotSent('ArticlePublished')
  })

  it('and the count is checked, not just the presence', async () => {
    await mailTo('ada@example.com').send(new ArticlePublished(article))
    await mailTo('grace@example.com').send(new ArticlePublished(article))

    fake.assertSentCount(2)
  })
})

describe('building without sending', () => {
  /**
   * `build()` resolves the view and the envelope with no transport at all.
   *
   * This is how a mailable is checked in isolation — the equivalent of Laravel's
   * assertions on `Mailable` itself, and the shape a preview route uses.
   */
  it('renders a mailable that never goes anywhere', async () => {
    const { expectMessage } = await import('@elysian/mail')

    const built = await mailer('array').build(new ArticlePublished(article), {
      to: [{ address: 'ada@example.com' }]
    })

    expectMessage(built)
      .assertHasSubject('Published: Something was published')
      .assertSeeInHtml('Something was published')
  })
})
