import { broadcaster } from '@elvel/broadcasting'
import { cache } from '@elvel/cache'
import { app, controller } from '@elvel/core'
import { db } from '@elvel/database'
import { dispatch, events } from '@elvel/events'
import { log, MemoryDriver } from '@elvel/log'
import { queue } from '@elvel/queue'
import { OrderShipped } from '../../Events/OrderShipped.ts'
import { RoomPinged } from '../../Events/RoomPinged.ts'
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

  /**
   * Events held until the work finishes — and dropped when it does not.
   *
   * Two requests through one process is the case a flag on the dispatcher gets
   * wrong, so the route runs a deferral and an ordinary dispatch at the same
   * time and reports what each heard.
   */
  .get('/deferred', async () => {
    const dispatcher = events()
    const heard: string[] = []

    dispatcher.forget('defer.probe')
    dispatcher.listen('defer.probe', (payload: { step: string }) => {
      heard.push(payload.step)
    })

    const held = dispatcher.defer(async () => {
      await dispatch('defer.probe', { step: 'committed' })
      await Bun.sleep(10)

      return heard.length
    })

    // Nothing from the deferral yet, and this one is not caught by it.
    await dispatch('defer.probe', { step: 'unrelated' })
    const duringDeferral = [...heard]

    const insideCount = await held

    const abandoned = await dispatcher
      .defer(async () => {
        await dispatch('defer.probe', { step: 'rolled back' })

        throw new Error('deliberate failure')
      })
      .then(() => 'no error')
      .catch((error: Error) => error.message)

    return { duringDeferral, insideCount, abandoned, heard }
  })

  /**
   * An event that broadcasts itself, dispatched normally.
   *
   * The route returns how many sockets it reached, which is the only honest
   * answer a broadcast can give: nothing about it guarantees delivery.
   */
  .post('/broadcast/:room', async ({ params, body }) => {
    const note =
      typeof (body as { note?: string })?.note === 'string'
        ? (body as { note: string }).note
        : 'ping'

    await dispatch(new RoomPinged(params.room, note))

    return { room: params.room, listeners: broadcaster().count(`room.${params.room}`) }
  })

  /**
   * Who is on a presence channel right now.
   *
   * `presenceAcross` rather than `presence`: on one process they are the same
   * answer, and behind a load balancer only the first one is right.
   */
  .get('/presence/:room', async ({ params }) => ({
    members: await broadcaster().presenceAcross(`room.${params.room}`)
  }))

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
