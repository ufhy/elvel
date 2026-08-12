import { Seeder, type SeederContext } from '@elysian/database'
import { Comment } from '../../app/Models/Comment.ts'
import { ArticleFactory } from '../factories/ArticleFactory.ts'

/** Generated with `bun run playground make:seeder ArticleSeeder`, then extended. */
export class ArticleSeeder extends Seeder {
  async run({ note }: SeederContext): Promise<void> {
    const articles = await new ArticleFactory().count(4).create()

    // Comments only on the first article, so eager loading has something
    // uneven to match.
    const first = articles.first()

    if (first) {
      await Comment.create({ article_id: first.id, author: 'Ada', body: 'First!' })
      await Comment.create({ article_id: first.id, author: 'Linus', body: 'Second.' })
    }

    note(`Seeded ${articles.count()} articles.`)
  }
}
