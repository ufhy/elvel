import { Command } from '@elysian/console'

/**
 * `encryption:rotate` — re-encrypt a column onto the current key.
 *
 * `APP_PREVIOUS_KEYS` keeps old payloads readable indefinitely, which is what
 * makes a key rotation possible with no downtime. What it does not do is *end*:
 * every old key has to stay configured for ever, and a key you cannot retire is
 * a key that has not really been rotated.
 *
 * This walks a table, decrypts with whichever key still works, and writes it
 * back under the current one. Once it has run for every encrypted column, the
 * previous keys can go.
 *
 * A column at a time, by design. The command cannot know which columns hold
 * ciphertext — a model's casts do — and guessing would either miss one or
 * mangle a column that merely looks like base64.
 */
export class EncryptionRotateCommand extends Command {
  static override signature =
    'encryption:rotate {table : The table to walk} {column : The encrypted column} {--key=id : Primary key column} {--chunk=200 : Rows per batch} {--connection= : Database connection} {--pretend : Report what would change, without writing}'

  static override description = 'Re-encrypt a column onto the current application key'

  /** A deploy runs this once; two copies would fight over the same rows. */
  static override isolatable = true

  async handle(): Promise<number> {
    if (!this.app.bound('db')) {
      this.error('encryption:rotate needs DatabaseServiceProvider.')

      return 1
    }

    const encrypter = this.app.make('encrypter')
    const table = this.argument('table')
    const column = this.argument('column')
    const key = this.stringOption('key') || 'id'
    const chunk = Math.max(1, Number(this.stringOption('chunk') || 200))
    const connection = this.stringOption('connection') || undefined

    const query = () => this.app.make('db').table(table, connection)

    let cursor: unknown = 0
    let rewritten = 0
    let skipped = 0
    let unreadable = 0

    for (;;) {
      const rows = (await (
        await query()
      )
        .where(key, '>', cursor)
        .orderBy(key)
        .limit(chunk)
        .get()) as unknown as Array<Record<string, unknown>>

      if (rows.length === 0) break

      for (const row of rows) {
        cursor = row[key]

        const payload = row[column]

        if (typeof payload !== 'string' || payload === '') {
          skipped += 1

          continue
        }

        let plain: string

        try {
          plain = encrypter.decryptString(payload, `${table}.${column}`)
        } catch {
          /**
           * Left exactly as it is, and counted.
           *
           * A row this key cannot read is either encrypted under a key nobody
           * configured or not encrypted at all. Overwriting either would destroy
           * data, so the command reports the number and moves on — the operator
           * decides what it means.
           */
          unreadable += 1

          continue
        }

        if (this.flag('pretend')) {
          rewritten += 1

          continue
        }

        await (await query())
          .where(key, row[key])
          .update({ [column]: encrypter.encryptString(plain, `${table}.${column}`) })

        rewritten += 1
      }
    }

    const verb = this.flag('pretend') ? 'would be re-encrypted' : 're-encrypted'

    this.output.tag('INFO', `${rewritten} row(s) ${verb} in ${table}.${column}.`)

    if (skipped > 0) this.comment(`${skipped} row(s) had nothing in that column.`)

    if (unreadable > 0) {
      this.warn(
        `${unreadable} row(s) could not be decrypted with any configured key, and were left alone. Check APP_PREVIOUS_KEYS before retiring it.`
      )
    }

    return 0
  }
}
