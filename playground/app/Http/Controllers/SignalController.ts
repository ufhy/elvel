import { cache } from '@elysian/cache'
import { app, controller } from '@elysian/core'
import { db } from '@elysian/database'
import { dispatch, events } from '@elysian/events'
import { log, MemoryDriver } from '@elysian/log'
import { queue } from '@elysian/queue'
import { OrderShipped } from '../../Events/OrderShipped.ts'
import { RecordShipments } from '../../Listeners/RecordShipments.ts'

/**
 * Exercise surface for events and logging, asserted by `scripts/smoke.ts`.
 */
export default controller('signal', '/signal')
  /** A class event reaching a discovered listener. */
  .get('/dispatch', async () => {
    const responses = await dispatch(new OrderShipped(42, 'DHL'))

    return { responses, recorded: [...RecordShipments.shipments] }
  })

  /**
   * The same event, reaching a listener that runs in a worker.
   *
   * The response comes back before the listener has run — that is the point —
   * so the route reports what is on the queue rather than what happened.
   */
  .post('/queued/:orderId', async ({ params }) => {
    const orderId = Number(params.orderId)

    await cache().forget(`warehouse:${orderId}`)
    await dispatch(new OrderShipped(orderId, 'DHL'))

    return {
      // Still nothing: the worker has not run.
      warehouse: (await cache().get<string>(`warehouse:${orderId}`)) ?? null,
      queued: await queue().connection().size('shipments')
    }
  })

  /** What the worker did, once it ran. */
  .get('/queued/:orderId', async ({ params }) => ({
    warehouse: (await cache().get<string>(`warehouse:${params.orderId}`)) ?? null
  }))

  /**
   * A queued listener dispatched inside a transaction that rolls back.
   *
   * `afterCommit` on the listener means nothing should reach the queue: the rows
   * the event is about never existed.
   */
  .post('/queued/:orderId/rollback', async ({ params }) => {
    const orderId = Number(params.orderId)
    const before = await queue().connection().size('shipments')

    try {
      await (await db().connection()).transaction(async () => {
        await dispatch(new OrderShipped(orderId, 'DHL'))

        throw new Error('deliberate rollback')
      })
    } catch {
      // Expected: the route is about what the queue did, not the error.
    }

    return { before, after: await queue().connection().size('shipments') }
  })

  /** Which queued listeners a worker could resolve by name. */
  .get('/listeners', () => ({
    queued: events().queuedListeners.names(),
    events: app('events.registry').names()
  }))

  /** Wildcard matching, and the fact that a string event carries its payload. */
  .get('/wildcard', async () => {
    const seen: string[] = []
    events().listen('probe.*', (name) => {
      seen.push(name)
    })

    await dispatch('probe.one', { a: 1 })
    await dispatch('probe.two')
    await dispatch('unrelated.three')

    return { seen }
  })

  /** `false` stops propagation; `until()` returns the first non-null response. */
  .get('/halting', async () => {
    const dispatcher = events()
    const order: string[] = []

    dispatcher.forget('halt.probe')
    dispatcher.listen('halt.probe', () => {
      order.push('first')
      return false
    })
    dispatcher.listen('halt.probe', () => {
      order.push('second')
    })

    const responses = await dispatcher.dispatch('halt.probe')

    dispatcher.forget('until.probe')
    dispatcher.listen('until.probe', () => null)
    dispatcher.listen('until.probe', () => 'answer')
    dispatcher.listen('until.probe', () => 'never reached')

    return { order, responses, until: await dispatcher.until('until.probe') }
  })

  /** Level thresholds, placeholder interpolation, sticky context, extend(). */
  .get('/log', () => {
    const memory = new MemoryDriver()

    // A custom driver — the same hook you would use to plug in pino or Sentry.
    log().extend('probe', () => memory)

    const probe = log()
      .build({ driver: 'probe', level: 'info' }, 'probe')
      .withContext({ request_id: 'fixed-for-the-test' })

    probe.debug('dropped by the level threshold')
    probe.info('User {id} signed in', { id: 7 })
    probe.error('Boom', { code: 500 })

    return {
      channel: probe.channel,
      levels: memory.records.map((record) => record.level),
      messages: memory.records.map((record) => record.message),
      context: memory.records[0]?.context ?? {}
    }
  })
