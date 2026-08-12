import { join } from 'node:path'
import { type Seeder, SeederRunner } from '../seeder.ts'
import { MigrationCommand } from './base.ts'

export class DbSeedCommand extends MigrationCommand {
  static override signature =
    'db:seed {--class=DatabaseSeeder : The seeder to run} {--database= : The connection to use} {--force : Run without confirming in production}'

  static override description = 'Seed the database'

  async handle(): Promise<number> {
    if (!(await this.confirmInProduction())) return 1

    const name = this.stringOption('class', 'DatabaseSeeder')
    const file = join(this.app.basePath('database', 'seeders'), `${name}.ts`)

    if (!(await Bun.file(file).exists())) {
      this.error(`Seeder [${name}] not found at database/seeders/${name}.ts`)
      return 1
    }

    const module = (await import(file)) as Record<string, unknown>
    const seeder = this.resolve(module, name)

    if (!seeder) {
      this.error(`No seeder class exported from database/seeders/${name}.ts`)
      return 1
    }

    const manager = this.app.make('db')
    const database = this.stringOption('database')
    const connection = await manager.connection(database === '' ? undefined : database)

    await new SeederRunner(connection, {
      onNote: (note) => this.output.tag('INFO', note)
    }).run(seeder)

    this.success('Seeding finished.')

    return 0
  }

  private resolve(module: Record<string, unknown>, name: string): (new () => Seeder) | undefined {
    const candidates = [module[name], module.default, ...Object.values(module)]

    for (const candidate of candidates) {
      if (typeof candidate !== 'function') continue

      const prototype = (candidate as { prototype?: { run?: unknown } }).prototype
      if (typeof prototype?.run === 'function') return candidate as new () => Seeder
    }

    return undefined
  }
}
