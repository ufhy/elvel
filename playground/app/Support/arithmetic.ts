/**
 * Work for a worker to do.
 *
 * A module rather than a closure, because a function cannot cross into a worker:
 * its captured scope does not travel, and Bun inlines captured constants into
 * the source it would hand over. The concurrency API takes `{ module, export,
 * args }` for exactly that reason.
 */
export function add(a: number, b: number): number {
  return a + b
}
