import { cache } from '@elysian/cache'
import { Job } from '@elysian/queue'

/**
 * Generated with `bun run playground make:job SyncSecret`, then extended.
 *
 * Carries something the queue itself should not hold in the clear, so the payload
 * is encrypted where it is stored. The job's own code is unchanged by that — it
 * reads `this.data` as any other job does.
 */
export class SyncSecret extends Job<{ token: string; label: string }> {
  static override tries = 1

  /** The stored payload holds a ciphertext instead of these fields. */
  static override encrypted = true

  async handle(): Promise<void> {
    // Recorded so a route can prove the worker saw the real value.
    await cache().forever(`secret:${this.data.label}`, this.data.token)
  }
}
