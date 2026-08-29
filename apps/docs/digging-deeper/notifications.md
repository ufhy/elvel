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

### The fields a provider reads

```ts
new MailMessage()
  .subject('Your receipt')
  .cc('accounts@example.com')
  .bcc('archive@example.com')
  .tag('billing')
  .metadata('invoice', String(invoice.id))
  .priority(1)
```

`cc` and `bcc` take one address or a list. `tag` and `metadata` are what Postmark,
Mailgun and SES group and search deliveries by; a driver that has no use for them
ignores them. `priority` becomes an `X-Priority` header.

### Lines that depend on something

```ts
new MailMessage()
  .line('Your order shipped.')
  .lineIf(order.isGift, 'The gift note is included.')
  .linesIf(order.delayed, ['Sorry it took a while.', 'Here is a voucher.'])
  .when(user.isAdmin, (mail) => mail.line(`Internal reference: ${order.id}`))
  .unless(user.verified, (mail) => mail.action('Verify your address', url))
```

Without these the alternative is a local variable and a branch, which is how a
message that reads like a message turns into a message that reads like code.

### Writing the body some other way

```ts
new MailMessage()
  .markdown('## This week\n\n- One thing\n- Another')
  .text('This week: one thing, another.')
  .template((parts) => `<html><body>${header()}${parts.join('')}</body></html>`)
  .attachMany(files)
```

`markdown()` and `view(Component, props)` are alternatives — the later call wins,
so a message that changes its mind does what it last said. Both are drawn with the
[theme stylesheet](/digging-deeper/mail#the-theme-is-a-stylesheet) the application
configured.

`text()` writes the plain-text half yourself. It is generated from the same lines
otherwise, which is right for a built message and wrong for a table: rendered as
text a table is a wall, and whoever wrote it knows what it should say.

`template()` replaces the document around the body for this one message; set
[`mail.layout`](/digging-deeper/mail#the-theme-is-a-stylesheet) to replace it for every notification.
The message wins when both are there. The default is a card on a grey
page, a safe answer and not every brand's answer. A layout receives the
rendered parts, which is the signature `emailLayout` itself has, so a replacement
that only adds a header can call the default from inside itself.

`via()` receives the notifiable, so a recipient can decide the channels:

```ts
via(user) {
  return user.wantsEmail ? ['mail', 'database'] : ['database']
}
```

A notification that only mails can say so without the list:

```ts
via() {
  return 'mail'
}
```

An empty string, or an empty list, sends nothing — which is what a `via()` that
computes its answer and comes back with nothing should do.

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

**One job per channel.** A mail server being down must not stop the inbox row
from being written, and each can be retried on its own.

### Channels that go different ways

```ts
viaQueues() {
  return { mail: 'mail-queue' }
}

viaConnections() {
  return { mail: 'redis' }
}
```

Name only the exceptions; anything unlisted keeps the notification's own `queue`
and `connection`. The two channels are not alike — mail goes through a provider
that rate-limits and can be down for minutes, a database row is one insert — so
routing them together makes the slow one hold up the fast one.

```ts
middleware(notifiable, channel) {
  return channel === 'mail' ? [new RateLimited(limiter(), 'mail', 60)] : []
}
```

Queue [middleware](/digging-deeper/queues#when-a-job-should-not-run), per channel and for the
same reason: a limiter protecting a mail provider has no business delaying the
row. It is rebuilt in the worker rather than carried in the payload, because a
middleware holding its own state is not something a queue can serialise.

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

### Calling a send off from outside

```ts
events().listen('notification.sending', ({ notification, channel }) => {
  if (channel === 'mail' && suppressed.has(notification)) return false
})
```

Returning `false` stops that channel and records a `notification.skipped`.
`shouldSend()` covers what the notification itself knows about; this covers what
it should not have to — a suppression list, a quiet-hours window, a customer who
asked for no mail.

The sender also announces `notification.sent` and `notification.failed`.

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
