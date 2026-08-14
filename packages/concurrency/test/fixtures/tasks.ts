/** Tasks a worker imports by name — the form that survives the boundary. */

export function add(a: number, b: number): number {
  return a + b
}

export default function greet(name: string): string {
  return `hello ${name}`
}

export function boom(): never {
  throw new Error('the task failed')
}

/** Busy work, deliberately CPU-bound so parallelism is measurable. */
export function spin(rounds: number): number {
  let total = 0
  for (let i = 0; i < rounds; i += 1) total = (total + Math.sqrt(i)) % 1_000_000

  return Math.round(total)
}

export function forever(): number {
  // Never returns; used to prove a timeout actually terminates the thread.
  while (true) {
    /* spin */
  }
}

/** Returns something `structuredClone` cannot copy. */
export function uncloneable(): () => string {
  return () => 'a function cannot cross a postMessage'
}
