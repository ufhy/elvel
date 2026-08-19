import { Seeder, type SeederContext } from '@elvel/database'

/**
 * The seeder `bun run elvel db:seed` runs by default.
 *
 * There is no auto-discovery: seed order matters, and a directory listing is a
 * bad way to express it. Compose explicitly with `call()`.
 */
export class DatabaseSeeder extends Seeder {
  async run({ note }: SeederContext): Promise<void> {
    // await call(UserSeeder)
    note('Nothing seeded yet — edit database/seeders/DatabaseSeeder.ts')
  }
}
