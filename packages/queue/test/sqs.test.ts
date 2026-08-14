import { describe, expect, test } from 'bun:test'
import type { JobPayload } from '../src/contracts.ts'
import { SqsQueue } from '../src/drivers/sqs.ts'

/**
 * The SQS driver against a real queue.
 *
 * ElasticMQ speaks the same query protocol and the same SigV4, so everything the
 * driver actually does — signing, the receipt-handle lifecycle, the receive
 * count, delayed visibility — is exercised for real. What it cannot cover is
 * AWS's own eventual consistency, which is noted in BEHAVIOURS.md.
 *
 *   docker run -d --name elysian-sqs -p 9324:9324 softwaremill/elasticmq-native
 *   TEST_SQS_ENDPOINT=http://127.0.0.1:9324/000000000000 bun test packages/queue
 *
 * Without an endpoint it skips with a note, as the other server suites do.
 */
const endpoint = process.env.TEST_SQS_ENDPOINT ?? 'http://127.0.0.1:9324/000000000000'

const credentials = {
  accessKeyId: process.env.TEST_SQS_KEY ?? 'x',
  secretAccessKey: process.env.TEST_SQS_SECRET ?? 'x',
  region: 'elasticmq'
}

/** One queue per run, so two suites against one server never collide. */
const queueName = `elysian-t${Date.now().toString(36)}`

const reachable = await (async () => {
  try {
    const created = await fetch(endpoint.replace(/\/[^/]*$/, '/'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        Action: 'CreateQueue',
        QueueName: queueName,
        Version: '2012-11-05'
      }).toString()
    })

    if (!created.ok) throw new Error(`CreateQueue answered ${created.status}`)

    return true
  } catch (error) {
    console.log(
      `  skipping the SQS round trip: ${(error instanceof Error ? error.message : String(error)).slice(0, 90)}`
    )

    return false
  }
})()

const driver = () =>
  new SqsQueue('sqs', { ...credentials, endpoint, queue: queueName, visibilityTimeout: 2 })

const payload = (overrides: Partial<JobPayload> = {}): JobPayload => ({
  uuid: crypto.randomUUID(),
  job: 'SendReport',
  displayName: 'SendReport',
  data: { to: 'ada@example.com' },
  attempts: 0,
  createdAt: Math.floor(Date.now() / 1000),
  ...overrides
})

describe.skipIf(!reachable)('SQS, against a real queue', () => {
  test('a pushed job comes back with its data intact', async () => {
    const sqs = driver()
    const sent = payload({ data: { to: 'ada@example.com', quoted: 'a "quoted" <value>' } })

    await sqs.push(sent)

    const job = await sqs.pop()

    // The payload travels as JSON inside XML, so quotes and angle brackets come
    // back escaped — decoding them is the driver's job, not the caller's.
    expect<unknown>(job?.payload.data).toEqual(sent.data)
    expect<string | undefined>(job?.payload.uuid).toBe(sent.uuid)

    await job?.delete()
  })

  test('a received message is invisible until it is released', async () => {
    const sqs = driver()
    await sqs.push(payload())

    const first = await sqs.pop()
    expect<boolean>(first !== null).toBe(true)

    // SQS *is* the reservation: while one worker holds it, nobody else sees it.
    expect<null | object>(await sqs.pop()).toBeNull()

    await first?.release(0)

    const again = await sqs.pop()
    expect<boolean>(again !== null).toBe(true)

    // Left behind, it would still be in the queue when the next test looks —
    // these tests share one queue, as two workers would share one in production.
    await again?.delete()
  })

  test('the attempt count is the receive count, not the payload', async () => {
    const sqs = driver()
    await sqs.push(payload())

    const first = await sqs.pop()
    expect<number | undefined>(first?.attempts()).toBe(1)

    await first?.release(0)

    const second = await sqs.pop()

    // The payload is never rewritten on SQS, so a driver reading `attempts` from
    // it would hand the worker 0 for ever and no job would exhaust its tries.
    expect<number | undefined>(second?.attempts()).toBe(2)

    await second?.delete()
  })

  test('a delete is what finishes a job', async () => {
    const sqs = driver()

    await sqs.clear()
    await sqs.push(payload())

    const job = await sqs.pop()
    await job?.delete()

    // Past the visibility timeout, so an undeleted message would be back.
    await Bun.sleep(2500)

    expect<null | object>(await sqs.pop()).toBeNull()
  }, 10_000)

  test('a delayed job is not available yet', async () => {
    const sqs = driver()

    await sqs.clear()
    await sqs.later(2, payload())

    expect<null | object>(await sqs.pop()).toBeNull()

    await Bun.sleep(2500)

    const job = await sqs.pop()
    expect<boolean>(job !== null).toBe(true)

    await job?.delete()
  }, 10_000)

  test('a delay beyond what SQS allows is refused, not clamped', async () => {
    // Arriving hours early is worse than never queueing: the fix is a scheduler
    // entry, and that is the caller's decision to make.
    await expect(driver().later(3600, payload())).rejects.toThrow('900 seconds')
  })

  test('size counts what is waiting, delayed and in flight', async () => {
    const sqs = driver()

    await sqs.clear()
    await sqs.push(payload())
    await sqs.later(30, payload())

    const inFlight = await sqs.pop()

    // Counting only what is visible would report zero for a queue whose jobs are
    // all being worked on.
    expect<number>(await sqs.size()).toBe(2)

    await inFlight?.delete()
    await sqs.clear()
  })

  test('a queue that does not exist names itself in the error', async () => {
    const missing = new SqsQueue('sqs', { ...credentials, endpoint, queue: 'nope-not-here' })

    // The AWS code alone does not say which queue was missing, and the usual
    // cause is a prefix built wrong.
    await expect(missing.push(payload())).rejects.toThrow('nope-not-here')
  })
})
