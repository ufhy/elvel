import { type Credentials, signRequest } from '@elysian/support'
import type { JobPayload, QueueDriver, QueuedJob } from '../contracts.ts'

export type SqsQueueOptions = Credentials & {
  region?: string
  /**
   * Everything before the queue name — `https://sqs.eu-west-1.amazonaws.com/1234567890`.
   *
   * A queue's URL is its identity in SQS, and it contains the account id, which
   * nothing else here knows. Naming the prefix once is how `queue: 'emails'`
   * stays a queue name rather than becoming a URL at every call site.
   */
  prefix?: string
  /** The queue used when none is named. */
  queue?: string
  /** Override the endpoint — a VPC endpoint, or ElasticMQ in a test. */
  endpoint?: string
  /**
   * How long a reserved message stays invisible, in seconds.
   *
   * Left to the queue's own setting by default. Like `retryAfter` on the other
   * drivers, it must exceed your slowest job: a job still running when it expires
   * is handed to a second worker.
   */
  visibilityTimeout?: number
}

/**
 * Amazon SQS — Laravel's `sqs` connection.
 *
 * The one driver here that does not own its reservations. SQS *is* the
 * reservation: a received message is invisible for its visibility timeout, and
 * deleting it by receipt handle is what finishes it. So there is no reserved set
 * to maintain, no migration of expired reservations, and no `retryAfter` sweep —
 * the queue does all of it, which is most of the reason to use it.
 *
 * Two things follow from that and are not choices:
 *
 * - **The attempt count is SQS's.** `ApproximateReceiveCount` is the only counter,
 *   and it counts *receives* rather than attempts, so a worker killed before it
 *   could release still increments it. That is the same trade Laravel makes.
 * - **`size()` is approximate.** Every SQS counter is, and a queue spread over
 *   several hosts cannot answer exactly without stopping. Do not build a
 *   "wait until empty" loop on it.
 *
 * Requests are signed with SigV4 from `@elysian/support` rather than through the
 * AWS SDK, and use the query protocol, which every S3-compatible SQS — including
 * ElasticMQ, which the tests run against — still speaks.
 */
export class SqsQueue implements QueueDriver {
  constructor(
    readonly connectionName: string,
    private readonly options: SqsQueueOptions
  ) {}

  get defaultQueue(): string {
    return this.options.queue ?? 'default'
  }

  /** The full URL of a queue. A name is resolved against the prefix. */
  private url(queue?: string): string {
    const name = queue ?? this.defaultQueue

    // Already a URL: `queue('https://sqs…/jobs')` is what a config generated
    // from Terraform tends to hold, and rewriting it would break it.
    if (name.startsWith('http://') || name.startsWith('https://')) return name

    const prefix = (this.options.endpoint ?? this.options.prefix ?? '').replace(/\/$/, '')

    return `${prefix}/${name}`
  }

  /** One signed query-protocol call. */
  private async call(
    queue: string | undefined,
    action: string,
    parameters: Record<string, string | number | undefined> = {}
  ): Promise<string> {
    const url = this.url(queue)
    const form = new URLSearchParams({ Action: action, Version: '2012-11-05' })

    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined) form.set(key, String(value))
    }

    const body = form.toString()

    const response = await fetch(url, {
      method: 'POST',
      headers: signRequest(
        {
          method: 'POST',
          url,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          region: this.options.region ?? 'us-east-1',
          service: 'sqs',
          now: new Date()
        },
        this.options
      ),
      body
    })

    const text = await response.text()

    if (!response.ok) {
      // The queue name is in the message because the usual cause is a URL built
      // from the wrong prefix, and "AWS.SimpleQueueService.NonExistentQueue"
      // alone does not say which queue was missing.
      throw new Error(
        `SQS ${action} on [${url}] failed (${response.status}): ${tag(text, 'Message') ?? text.slice(0, 200)}`
      )
    }

    return text
  }

  async push(payload: JobPayload, queue?: string): Promise<string> {
    return this.send(payload, queue)
  }

  async later(delay: number, payload: JobPayload, queue?: string): Promise<string> {
    /**
     * SQS caps a delay at fifteen minutes.
     *
     * Refused rather than clamped: a job silently arriving hours early is worse
     * than one that never queued, and the fix — a scheduler entry, or a job that
     * re-queues itself — is a decision for the caller.
     */
    if (delay > 900) {
      throw new Error(
        `SQS allows a delay of at most 900 seconds; [${payload.displayName}] asked for ${delay}. Schedule it instead, or have the job re-queue itself.`
      )
    }

    return this.send(payload, queue, Math.max(0, Math.floor(delay)))
  }

  private async send(payload: JobPayload, queue?: string, delay?: number): Promise<string> {
    const response = await this.call(queue, 'SendMessage', {
      MessageBody: JSON.stringify(payload),
      DelaySeconds: delay
    })

    return tag(response, 'MessageId') ?? payload.uuid
  }

  async pop(queue?: string): Promise<QueuedJob | null> {
    const response = await this.call(queue, 'ReceiveMessage', {
      MaxNumberOfMessages: 1,
      // The only counter SQS keeps, and what `attempts()` reports.
      'AttributeName.1': 'ApproximateReceiveCount',
      VisibilityTimeout: this.options.visibilityTimeout
    })

    const body = tag(response, 'Body')
    const handle = tag(response, 'ReceiptHandle')

    if (body === undefined || handle === undefined) return null

    const payload = JSON.parse(decodeEntities(body)) as JobPayload
    const received = Number(attribute(response, 'ApproximateReceiveCount') ?? '1')

    return new SqsJob(
      // The count is authoritative, not the payload's own: the payload is never
      // rewritten on SQS, so its `attempts` would stay at whatever was pushed.
      { ...payload, attempts: received },
      this.url(queue),
      this.connectionName,
      decodeEntities(handle),
      this
    )
  }

  /**
   * Approximate, and deliberately the sum of all three counters.
   *
   * Available, delayed and in-flight together answer "is there work here?", which
   * is what a caller means. Counting only what is visible reports zero for a
   * queue whose jobs are all being worked on.
   */
  async size(queue?: string): Promise<number> {
    const response = await this.call(queue, 'GetQueueAttributes', {
      'AttributeName.1': 'ApproximateNumberOfMessages',
      'AttributeName.2': 'ApproximateNumberOfMessagesDelayed',
      'AttributeName.3': 'ApproximateNumberOfMessagesNotVisible'
    })

    return (
      Number(attribute(response, 'ApproximateNumberOfMessages') ?? 0) +
      Number(attribute(response, 'ApproximateNumberOfMessagesDelayed') ?? 0) +
      Number(attribute(response, 'ApproximateNumberOfMessagesNotVisible') ?? 0)
    )
  }

  /**
   * Purge the queue.
   *
   * AWS allows one purge per sixty seconds and completes it in its own time, so
   * the count returned is what was there when asked, not what was removed. On a
   * real queue, prefer deleting and recreating it if you need certainty.
   */
  async clear(queue?: string): Promise<number> {
    const size = await this.size(queue)

    await this.call(queue, 'PurgeQueue')

    return size
  }

  /** Finish a message: only a delete stops SQS handing it out again. */
  async deleteMessage(queueUrl: string, handle: string): Promise<void> {
    await this.call(queueUrl, 'DeleteMessage', { ReceiptHandle: handle })
  }

  /**
   * Make a message visible again, after `delay` seconds.
   *
   * A release is a visibility change rather than a re-push: re-pushing would
   * create a second message and lose the receive count, so a job that fails
   * forever would look like a fresh one every time and never exhaust its tries.
   */
  async releaseMessage(queueUrl: string, handle: string, delay: number): Promise<void> {
    await this.call(queueUrl, 'ChangeMessageVisibility', {
      ReceiptHandle: handle,
      VisibilityTimeout: Math.max(0, Math.floor(delay))
    })
  }
}

/** A message received from SQS. */
class SqsJob implements QueuedJob {
  private deleted = false
  private released = false
  private failed = false

  constructor(
    readonly payload: JobPayload,
    /** The queue's URL, which is what every call needs. */
    readonly queue: string,
    readonly connectionName: string,
    private readonly handle: string,
    private readonly driver: SqsQueue
  ) {}

  attempts(): number {
    return this.payload.attempts
  }

  async delete(): Promise<void> {
    this.deleted = true

    await this.driver.deleteMessage(this.queue, this.handle)
  }

  async release(delay = 0): Promise<void> {
    this.released = true

    await this.driver.releaseMessage(this.queue, this.handle, delay)
  }

  /**
   * A failed job is deleted here, as everywhere else.
   *
   * The failed-job store already has the payload; leaving the message for SQS to
   * hand out again would run a job that has already been given up on.
   */
  async fail(_error: unknown): Promise<void> {
    this.failed = true

    await this.driver.deleteMessage(this.queue, this.handle)
  }

  isDeleted(): boolean {
    return this.deleted
  }

  isReleased(): boolean {
    return this.released
  }

  hasFailed(): boolean {
    return this.failed
  }
}

/**
 * The first `<Tag>…</Tag>` in a response.
 *
 * A regular expression rather than an XML parser: these documents have one
 * shape, defined by AWS, and a driver that pulled in a parser to read four
 * fields would be paying for the whole of XML.
 */
function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]
}

/** The value of one `<Attribute><Name>x</Name><Value>y</Value></Attribute>`. */
function attribute(xml: string, name: string): string | undefined {
  const pattern = new RegExp(
    `<Attribute>\\s*<Name>${name}</Name>\\s*<Value>([\\s\\S]*?)</Value>\\s*</Attribute>`
  )

  return pattern.exec(xml)?.[1]
}

/** A JSON payload inside XML arrives with its quotes and angle brackets escaped. */
function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}
