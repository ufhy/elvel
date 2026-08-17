import { Factory } from '@elvel/database'
import { Article } from '../../app/Models/Article.ts'

export class ArticleFactory extends Factory<Article> {
  readonly model = Article

  /**
   * `index` is 0-based and unique per generated row, so derive unique values
   * from it rather than from a random source that can collide with a unique
   * index and fail one run in fifty.
   */
  definition(index: number) {
    return {
      title: `Article ${index}`,
      // Derived from the index, so a unique index cannot collide.
      slug: `article-${index}`,
      body: `Body text for article ${index}, long enough to be an excerpt source.`,
      status: index % 2 === 0 ? 'published' : 'draft',
      featured: index === 0,
      meta: { index }
    }
  }
}
