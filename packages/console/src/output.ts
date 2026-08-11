import * as prompts from '@clack/prompts'
import pc from 'picocolors'

/**
 * Terminal output + interaction.
 *
 * Argument parsing is ours (signature-driven, like Artisan) but the interactive
 * layer is `@clack/prompts` — it is 2KB against Enquirer's ~100KB and Ink's
 * ~150KB + React, which matters because the CLI is meant to be shipped with
 * `bun build --compile`.
 */
export class Output {
  line(message = ''): void {
    console.log(message)
  }

  info(message: string): void {
    console.log(pc.cyan(message))
  }

  success(message: string): void {
    console.log(`${pc.green('✔')} ${message}`)
  }

  comment(message: string): void {
    console.log(pc.dim(message))
  }

  warn(message: string): void {
    console.log(`${pc.yellow('⚠')} ${message}`)
  }

  error(message: string): void {
    console.error(`${pc.red('✖')} ${message}`)
  }

  /** `INFO  Created app/Http/Controllers/PostController.ts` */
  tag(label: string, message: string, color: 'green' | 'red' | 'yellow' | 'blue' = 'green'): void {
    const painted = { green: pc.bgGreen, red: pc.bgRed, yellow: pc.bgYellow, blue: pc.bgBlue }[
      color
    ]
    console.log(`${painted(pc.black(` ${label} `))} ${message}`)
  }

  /** Two-column key/value list, as `artisan about` prints. */
  pairs(rows: Array<[string, string]>, width = 28): void {
    for (const [key, value] of rows) {
      const dots = pc.dim('.'.repeat(Math.max(2, width - key.length)))
      console.log(`  ${key} ${dots} ${pc.white(value)}`)
    }
  }

  table(headers: string[], rows: string[][]): void {
    const widths = headers.map((header, column) =>
      Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length))
    )

    const renderRow = (cells: string[], paint: (value: string) => string) =>
      cells.map((cell, column) => paint(cell.padEnd(widths[column] ?? 0))).join('  ')

    console.log(renderRow(headers, (value) => pc.bold(pc.dim(value))))
    for (const row of rows) console.log(renderRow(row, (value) => value))
  }

  // ------------------------------------------------------------- interaction

  async ask(question: string, defaultValue?: string): Promise<string> {
    const answer = await prompts.text({
      message: question,
      defaultValue,
      placeholder: defaultValue
    })
    return this.unwrap(answer, defaultValue ?? '')
  }

  async secret(question: string): Promise<string> {
    const answer = await prompts.password({ message: question })
    return this.unwrap(answer, '')
  }

  async confirm(question: string, defaultValue = false): Promise<boolean> {
    const answer = await prompts.confirm({ message: question, initialValue: defaultValue })
    return this.unwrap(answer, defaultValue)
  }

  async choice<T extends string>(question: string, choices: T[], defaultValue?: T): Promise<T> {
    const answer = await prompts.select({
      message: question,
      // Clack's `Option<T>` is conditional on `T extends Primitive`, which TS
      // cannot resolve while `T` is still generic here.
      options: choices.map((choice) => ({ value: choice, label: choice })) as never,
      initialValue: defaultValue
    })
    return this.unwrap(answer as T | symbol, defaultValue ?? (choices[0] as T))
  }

  spinner(): { start(message?: string): void; stop(message?: string): void } {
    return prompts.spinner()
  }

  intro(message: string): void {
    prompts.intro(pc.bgCyan(pc.black(` ${message} `)))
  }

  outro(message: string): void {
    prompts.outro(message)
  }

  /** Clack returns a cancel symbol on Ctrl-C; treat that as "abort the command". */
  private unwrap<T>(value: T | symbol, fallback: T): T {
    if (prompts.isCancel(value)) {
      prompts.cancel('Aborted.')
      process.exit(130)
    }
    return (value as T) ?? fallback
  }
}
