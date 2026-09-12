/** A page whose only job is to be badly written, so the inspector has something to find. */
export function Slow({ titles }: { titles: string[] }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>A deliberately slow page — playground</title>
        <style>{`
          body { font: 15px/1.6 ui-sans-serif, system-ui; margin: 0; padding: 48px 24px 120px; color: #1a202c; }
          main { max-width: 720px; margin: 0 auto; }
          h1 { font-size: 34px; margin: 0 0 8px; }
          p { color: #4a5568; }
          li { margin: 4px 0; }
          code { background: #edf2f7; padding: 1px 5px; border-radius: 4px; }
        `}</style>
      </head>
      <body>
        <main>
          <h1>A deliberately slow page</h1>
          <p>
            Every mistake here is on purpose. Open the Lens bar: it should name an N+1, a slow
            query, an exception that never reached you, and a cache that is not caching.
          </p>
          <ul>
            {titles.map((title) => (
              <li safe>{title}</li>
            ))}
          </ul>
          <p>
            Source: <code>app/Http/Controllers/SlowController.ts</code>
          </p>
        </main>
      </body>
    </html>
  )
}
