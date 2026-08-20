# Notifications

One message, several channels. A notification says *what* to tell somebody and
*by which routes*; the channels do the delivering.

```ts
import { MailMessage, Notification } from '@elvel/notifications'

export class ArticlePublished extends Notification<{ title: string }> {
  via() {
    return ['mail', 'database']
  }

  toMail() {
    return new MailMessage()
      .subject(`Published: ${this.data.title}`)
      .greeting('Hello Ada')
      .line('Your article is live.')
      .action('Read it', url)
      .line('Thanks for writing.')
  }

  toDatabase() {
    return { title: this.data.title }
  }
}
```

```ts
import { notify } from '@elvel/notifications'

await notify(user, new ArticlePublished({ title }))
await notify([editor, author], new ArticlePublished({ title }))
```

`bun elvel make:notification ArticlePublished` writes the class. `data` is the
constructor argument, as with a job or a mailable, for the same reason: a
notification can be queued, and then only its data travels.

## `MailMessage` builds the mail for you

```ts
new MailMessage()
  .subject('…').greeting('…').line('…').action('Read it', url).line('…')
  .salutation('…').success().error().from(address, name).replyTo(address)
  .attach(file).markdown('# Or write it yourself')
```

Rendered, that produces both parts. The text:

```
Hello Ada

Your article is live.

Read it: https://example.com/a/1

Thanks for writing.

Regards,
Elvel
```

…and an HTML version with the styles inline, for the reason the
[mail page](/digging-deeper/mail#markdown) gives: Gmail strips `<style>` blocks.
The closing name is the application's, from `config/app.ts`.

`via()` receives the notifiable, so a recipient can decide the channels:

```ts
via(user) {
  return user.wantsEmail ? ['mail', 'database'] : ['database']
}
```

## Who receives it

Anything with an `email` is already a `mail` recipient — that is the default
route Laravel reads too. Anything more specific declares its own:

```ts
class User extends Model {
  routeNotificationFor(channel: string) {
    if (channel === 'mail') return this.email
    if (channel === 'slack') return this.slackWebhook
    return null                       // not by this channel
  }
}
```

Returning `null` means "not this way", which is how one notification reaches
users who have different contact details without any branching in the
notification itself.

### On-demand recipients

```ts
import { route } from '@elvel/notifications'

await notify(route('mail', 'ops@example.com'), new ArticlePublished({ title }))
```

For somebody who is not a model — an ops address, a webhook. The `database`
channel **refuses** an on-demand recipient rather than inventing one:

```
The database channel cannot take an on-demand notification:
there is no record to attach it to.
```

## Channels

`mail`, `database`, `broadcast` and `log` ship with the package.

The `database` channel is what an in-app inbox reads:

```bash
bun elvel notifications:table && bun elvel migrate
```

The row carries the payload from `toDatabase()` (or `toArray()`), plus the
recipient's type and key, so one table serves every kind of recipient. Reading it
back is a model, not a filter over everything ever stored:

```ts
import { DatabaseNotification } from '@elvel/notifications'

const unread = await DatabaseNotification.query().scope('unread').get()

for (const notification of unread.all()) {
  notification.isUnread()          // true
  notification.data                // { title: 'Hello' } — cast from json
  await notification.markAsRead()
}
```

Two shapes worth noticing. A model scope declared as `scopeUnread(query)` is
called through `.scope('unread')`, not as a method of its own. And `get()`
resolves to a **`Collection`**, not an array — `.all()`, `.count()`, `.first()`
rather than `[0]` and `.length`.

`markAsRead()` is idempotent: marking a read notification again does not move its
timestamp. `scope('read')` is the other side.

The key is **a uuid the sender generated**, not an auto-increment, and it is one
id per recipient shared by every channel that recipient gets. So the mail and the
inbox row for the same event agree on an identifier, which is what lets a click
in the mail mark the row read.

## Queueing

```ts
export class ArticlePublished extends Notification<{ title: string }> {
  static override shouldQueue = true
  static override queue = 'notifications'
}
```

`notify()` then hands it to the queue; `notifyNow()` sends it in this process
even when the notification asked to be queued. A queued notification is
registered by name, for the reason jobs and mailables are: a payload can only
carry a name, and the name has to resolve in a different process.

## The recipient's language

```ts
class User extends Model {
  preferredLocale() {
    return this.locale
  }
}
```

The sender switches the translator for the duration of the send. That is the only
correct place for it: a notification is rendered long after the request that
caused it — often in a worker with no request at all — so the recipient's
language cannot come from an incoming `Accept-Language`.

## Skipping and following up

```ts
shouldSend(notifiable, channel) {
  return channel !== 'mail' || notifiable.emailVerified
}

afterSending(notifiable, channel, response) {
  log().info(`sent by ${channel}`)
}
```

## Testing

```ts
const fake = notifications().fake()

await notify(user, new ArticlePublished({ title: 'Hello' }))

fake.assertSentTo(user, 'ArticlePublished')
fake.assertSentVia(user, 'ArticlePublished', 'mail')
fake.assertSentTimes('ArticlePublished', 1)
fake.assertNotSentTo(other, 'ArticlePublished')
fake.assertNothingSent()
```

`fake.sent('ArticlePublished')` returns the records, including which channels
each one used:

```
[["mail","log"]]
```

To assert on the mail a notification actually produced, fake the **mailer**
instead and let the notification run:

```ts
const sent = mail().fake()

await notify({ id: 7, email: 'ada@example.com' }, new ArticlePublished({ title: 'Hello' }))

sent.assertSent('ArticlePublished').assertHasTo('ada@example.com')
```

The mailer records it under the **notification's** name, so that is what to look
for:

```
Published: Hello   → [{ "address": "ada@example.com" }]
Published: For ops → [{ "address": "ops@example.com" }]
```

That is the difference worth knowing: faking notifications proves the decision to
notify, faking the mailer proves what the message says.
