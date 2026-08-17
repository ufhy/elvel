import { Seeder, type SeederContext } from '@elvel/database'
import { ArticleSeeder } from './ArticleSeeder.ts'

/**
 * The seeder `bun run artisan db:seed` runs by default.
 *
 * There is no auto-discovery: seed order matters, and a directory listing is a
 * bad way to express it. Compose explicitly with `call()`.
 */
export class DatabaseSeeder extends Seeder {
  async run({ call }: SeederContext): Promise<void> {
    await call(ArticleSeeder)
  }
}
