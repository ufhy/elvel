/**
 * How concurrent tasks run.
 *
 * `worker` is the only driver that buys another core. `Promise.all` already
 * covers everything I/O-bound, which is most of what a request waits for, so
 * reach for this when the work is actually computing.
 *
 * `sync` runs tasks one after another in this process. Use it in tests, and
 * remember it accepts a plain function where `worker` does not — a task crossing
 * into a worker must be named as `{ module, export, args }`.
 */
export default {
  driver: process.env.CONCURRENCY_DRIVER ?? 'worker'
}
