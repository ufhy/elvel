import type { ApplicationContract } from '@elysian/contracts'
import { MailFake } from './fake.ts'
import type { Address, AnyMailable, MailableClass } from './mailable.ts'
import { Mailer, type ViewRenderer } from './mailer.ts'
import type { SentMessage, Transport } from './message.ts'
import { MailableRegistry, SendQueuedMail } from './queued.ts'
import { ArrayTransport } from './transports/array.ts'
import { FailoverTransport, RoundRobinTransport } from './transports/fallback.ts'
import { MailgunTransport, PostmarkTransport, ResendTransport } from './transports/http.ts'
import { LogTransport } from './transports/log.ts'
import { SesTransport } from './transports/ses.ts'
import { SmtpTransport } from './transports/smtp.ts'

export type MailerConfig = { transport: string } & Record<string, unknown>

/** Builds a transport from its configuration — how `extend()` adds one. */
export type TransportFactory = (
  name: string,
  config: MailerConfig,
  app: ApplicationContract
) => Transport

/**
 * Resolves mailers — `Illuminate\Mail\MailManager`.
 *
 * A `Mailer` is memoised per name so an SMTP pool is opened once, and every
 * mailer shares the sender, the "always to" override and the view renderer from
 * config.
 */
export class MailManager {
  /** Mailables a worker can resolve by name. Filled by discovery. */
  readonly mailables = new MailableRegistry()

  private readonly mailers = new Map<string, Mailer>()
  private readonly customTransports = new Map<string, TransportFactory>()

  /** Set by `fake()`; while it is set, nothing leaves the process. */
  private faked: MailFake | undefined

  constructor(private readonly app: ApplicationContract) {}

  mailer(name?: string): Mailer {
    // While faking, every name resolves to the same recording mailer: a test that
    // named a mailer explicitly must not slip past the fake and send for real.
    if (this.faked) return this.faked.mailer

    const resolved = name ?? this.defaultMailer()
    const cached = this.mailers.get(resolved)
    if (cached) return cached

    const mailer = new Mailer(resolved, this.transport(resolved), this.mailerOptions(resolved))

    this.mailers.set(resolved, mailer)

    return mailer
  }

  /**
   * Record messages instead of sending them.
   *
   * The returned fake is a real mailer with the `array` transport behind it, so an
   * assertion reads the message that would have gone out.
   */
  fake(): MailFake {
    const transport = new ArrayTransport()
    const options = this.mailerOptions('array')

    const fake = new MailFake(new Mailer('array', transport, options), transport)

    // A queued message is recorded too, rather than reaching a worker.
    ;(options as { queue?: unknown }).queue = async (
      mailable: AnyMailable,
      overrides: Partial<SentMessage>
    ) => {
      fake.recordQueued(await fake.mailer.build(mailable, overrides))

      return 'faked'
    }

    this.faked = fake

    return fake
  }

  /** Stop faking and send for real again. */
  restore(): void {
    this.faked = undefined
  }

  get isFaking(): boolean {
    return this.faked !== undefined
  }

  /** Shared options: the sender, the override, the renderer, the queue hook. */
  private mailerOptions(name: string) {
    return {
      from: this.app.config.get<Address | undefined>('mail.from'),
      alwaysTo: this.app.config.get<Address | undefined>('mail.alwaysTo'),
      replyTo: this.app.config.get<Address | undefined>('mail.replyTo'),
      render: this.app.bound('view')
        ? // Cast because the factory is typed for its own component shape; the
          // renderer contract in `mailer.ts` is deliberately narrower.
          (((component: never, props: never) => this.app.make('view').render(component, props)) as
            | ViewRenderer
            | undefined)
        : undefined,
      events: this.app.bound('events')
        ? (this.app.make('events' as never) as {
            dispatch(event: string, payload?: unknown): unknown
          })
        : undefined,
      queue: this.app.bound('queue')
        ? async (mailable: AnyMailable, overrides: Partial<SentMessage>, delay?: number) => {
            // The mailable is registered on the way out, so a worker started
            // afterwards can still resolve it even if discovery missed it.
            this.mailables.register(mailable.constructor as MailableClass)

            return this.app.make('queue').dispatch(
              new SendQueuedMail({
                mailable: mailable.constructor.name,
                data: mailable.data,
                mailer: name,
                to: overrides.to,
                cc: overrides.cc,
                bcc: overrides.bcc
              }),
              {
                delay,
                queue: (mailable.constructor as { queue?: string }).queue,
                connection: (mailable.constructor as { connection?: string }).connection
              }
            )
          }
        : undefined
    }
  }

  /** Shorthand for `mailer().to(...)`. */
  to(recipients: Address | Address[]) {
    return this.mailer().to(recipients)
  }

  defaultMailer(): string {
    return this.app.config.get<string>('mail.default', 'log')
  }

  extend(transport: string, factory: TransportFactory): this {
    this.customTransports.set(transport, factory)
    this.mailers.clear()

    return this
  }

  /** Drop the memoised mailers, closing anything they opened. */
  forgetMailers(): void {
    for (const mailer of this.mailers.values()) {
      if (mailer.transport instanceof SmtpTransport) mailer.transport.close()
    }

    this.mailers.clear()
  }

  private transport(name: string): Transport {
    const config = this.app.config.get<MailerConfig | undefined>(`mail.mailers.${name}`)

    if (!config) {
      throw new Error(`Mailer [${name}] is not configured. Add it to config/mail.ts.`)
    }

    return this.build(name, config)
  }

  /** The transport a configuration asks for. */
  build(name: string, config: MailerConfig): Transport {
    const custom = this.customTransports.get(config.transport)
    if (custom) return custom(name, config, this.app)

    switch (config.transport) {
      case 'array':
        return new ArrayTransport()

      case 'log':
        return new LogTransport(
          this.app.bound('log')
            ? (this.app.make('log' as never) as {
                info(message: string, context?: Record<string, unknown>): void
              })
            : { info: (message: string) => console.log(message) }
        )

      case 'smtp': {
        const allowSelfSigned = config.allowSelfSigned === true

        // A staging flag that reached production would mean mail readable by
        // anyone on the path, so it is refused rather than quietly honoured.
        if (allowSelfSigned && this.app.isProduction()) {
          throw new Error(
            `Mailer [${name}] sets allowSelfSigned, which is refused in production: use a properly issued certificate, or add your CA to the trust store.`
          )
        }

        return new SmtpTransport({
          host: String(config.host ?? '127.0.0.1'),
          port: config.port === undefined ? undefined : Number(config.port),
          secure: config.secure === undefined ? undefined : config.secure === true,
          username: config.username as string | undefined,
          password: config.password as string | undefined,
          timeout: config.timeout === undefined ? undefined : Number(config.timeout),
          pool: config.pool === true,
          allowSelfSigned
        })
      }

      case 'resend':
        return new ResendTransport({
          key: String(config.key ?? ''),
          endpoint: config.endpoint as string | undefined
        })

      case 'postmark':
        return new PostmarkTransport({
          key: String(config.key ?? ''),
          endpoint: config.endpoint as string | undefined,
          stream: config.stream as string | undefined
        })

      case 'mailgun':
        return new MailgunTransport({
          key: String(config.key ?? ''),
          domain: String(config.domain ?? ''),
          endpoint: config.endpoint as string | undefined
        })

      case 'ses':
        return new SesTransport({
          region: String(config.region ?? 'us-east-1'),
          accessKeyId: String(config.accessKeyId ?? ''),
          secretAccessKey: String(config.secretAccessKey ?? ''),
          sessionToken: config.sessionToken as string | undefined,
          endpoint: config.endpoint as string | undefined,
          configurationSet: config.configurationSet as string | undefined,
          fromArn: config.fromArn as string | undefined
        })

      case 'failover':
        return new FailoverTransport(this.nested(name, config))

      case 'roundrobin':
        return new RoundRobinTransport(this.nested(name, config))

      default:
        throw new Error(
          `Mail transport [${config.transport}] for mailer [${name}] is not supported. Register it with mail().extend().`
        )
    }
  }

  /** The transports a `failover` or `roundrobin` mailer wraps. */
  private nested(name: string, config: MailerConfig): Transport[] {
    const names = (config.mailers ?? []) as string[]

    if (names.length === 0) {
      throw new Error(`Mailer [${name}] needs a "mailers" list of the mailers to use.`)
    }

    return names.map((nested) => {
      const nestedConfig = this.app.config.get<MailerConfig | undefined>(`mail.mailers.${nested}`)

      if (!nestedConfig) {
        throw new Error(`Mailer [${name}] refers to mailer [${nested}], which is not configured.`)
      }

      return this.build(nested, nestedConfig)
    })
  }
}
