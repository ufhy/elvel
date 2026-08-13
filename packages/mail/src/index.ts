export { attachFromDisk, type DiskAttachmentOptions } from './attachments.ts'
export { MakeMailCommand } from './console/make-mail.ts'
export { MailFake } from './fake.ts'
export { mail, mailer, mailTo } from './helpers.ts'
export {
  type Address,
  type AnyMailable,
  type Attachment,
  addresses,
  type Content,
  type Envelope,
  formatAddress,
  Mailable,
  type MailableClass,
  viewContent
} from './mailable.ts'
export { Mailer, type MailerOptions, PendingMail, type ViewRenderer } from './mailer.ts'
export { type MailerConfig, MailManager, type TransportFactory } from './manager.ts'
export {
  type DeliveryResult,
  recipientsOf,
  type SentMessage,
  type Transport
} from './message.ts'
export { MailServiceProvider } from './provider.ts'
export { MailableRegistry, type QueuedMailData, SendQueuedMail } from './queued.ts'
export { ArrayTransport } from './transports/array.ts'
export { FailoverTransport, RoundRobinTransport } from './transports/fallback.ts'
export {
  type HttpTransportOptions,
  MailgunTransport,
  PostmarkTransport,
  ResendTransport
} from './transports/http.ts'
export { LogTransport, type LogWriter } from './transports/log.ts'
export { type SmtpOptions, SmtpTransport } from './transports/smtp.ts'
