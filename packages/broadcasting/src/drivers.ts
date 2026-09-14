import type { PublishedMessage, PubSub } from './broadcaster.ts'

/**
 * Print what would have gone out.
 *
 * For seeing a broadcast without a socket in sight — a command, a test run, a
 * staging box with no browser attached. The frame is printed whole, because the
 * question this driver answers is "what exactly was sent".
 *
 * Zero subscribers, always, and that is honest: nothing is listening, and a
 * gather that believed otherwise would wait for replies nobody is going to
 * send.
 */
export class LogPubSub implements PubSub {
  constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

  async publish(message: PublishedMessage): Promise<number> {
    this.write(`[broadcast] ${JSON.stringify(message)}`)

    return 0
  }

  onMessage(_handler: (message: PublishedMessage) => void): void {
    // Nothing arrives: this driver has no other end.
  }

  close(): void {}
}

/**
 * Broadcast nowhere.
 *
 * `BROADCAST_DRIVER=null` used to give `memory` silently, so switching
 * broadcasting off in CI quietly left it on within the process. This is the
 * deliberate off switch, and an unknown driver name is now an error rather than
 * another way to reach `memory`.
 */
export class NullPubSub implements PubSub {
  async publish(_message: PublishedMessage): Promise<number> {
    return 0
  }

  onMessage(_handler: (message: PublishedMessage) => void): void {}

  close(): void {}
}
