import type { Attachment } from './mailable.ts'

/**
 * A message with everything resolved: the view rendered, the addresses
 * normalised, the subject settled.
 *
 * This is what a transport receives. Keeping it a plain object rather than a
 * builder is what makes the `array` transport a complete test double — an
 * assertion can read every field without knowing anything about mail.
 */
export type SentMessage = {
  /**
   * Name of the mailable this came from.
   *
   * Carried on the message so a transport, a log line and a test assertion can
   * all say *what* was sent without the sender having to pass it separately.
   */
  mailable: string
  from: { address: string; name?: string }
  to: Array<{ address: string; name?: string }>
  cc: Array<{ address: string; name?: string }>
  bcc: Array<{ address: string; name?: string }>
  replyTo: Array<{ address: string; name?: string }>
  /**
   * Where bounces go, when it is not the `From`.
   *
   * The envelope sender, not a header a reader sees. Without it every bounce
   * lands on `From`, so an application that wants to process them — remove a
   * dead address, stop sending to it — has nowhere to point the handler, and
   * VERP, which encodes the recipient into the return path so a bounce
   * identifies itself, is impossible.
   */
  returnPath?: { address: string; name?: string }
  subject: string
  html?: string
  text?: string
  attachments: Attachment[]
  tags: string[]
  metadata: Record<string, string>
  headers: Record<string, string>
}

/** What a transport reports back. */
export type DeliveryResult = {
  /** Provider identifier, when the provider gives one. */
  id?: string
  /** Name of the transport that accepted it. */
  transport: string
}

/** A way to deliver a built message. */
export interface Transport {
  readonly name: string

  send(message: SentMessage): Promise<DeliveryResult>
}

/** Every recipient, for logging and for a global "to" override. */
export function recipientsOf(message: SentMessage): string[] {
  return [...message.to, ...message.cc, ...message.bcc].map((mailbox) => mailbox.address)
}
