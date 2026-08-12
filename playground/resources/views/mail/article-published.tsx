export type ArticlePublishedProps = {
  title: string
  excerpt: string
  url: string
}

/**
 * The HTML body of the ArticlePublished mail.
 *
 * Deliberately not wrapped in the site `Layout`: mail clients ignore most of a
 * stylesheet, so the styles that matter are inline and the markup stays plain.
 * It is still the same JSX renderer the web views use — there is no second
 * template engine to learn.
 */
export function ArticlePublishedMail({ title, excerpt, url }: ArticlePublishedProps) {
  return (
    <html lang="en">
      <body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
        <h1 style="font-size: 20px; margin: 0 0 12px;" safe>
          {title}
        </h1>

        <p style="margin: 0 0 16px;" safe>
          {excerpt}
        </p>

        <p style="margin: 0 0 16px;">
          <a href={url} style="color: #2563eb;">
            Read it
          </a>
        </p>

        <p style="font-size: 12px; color: #666; margin: 24px 0 0;">
          You are receiving this because you subscribed to the playground.
        </p>
      </body>
    </html>
  )
}
