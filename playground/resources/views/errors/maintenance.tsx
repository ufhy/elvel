export type MaintenanceProps = {
  retryAfter?: number | undefined
}

/**
 * The page `elvel down --render=errors.maintenance` bakes into the down file.
 *
 * No layout import on purpose: this HTML is written to disk when `down` runs and
 * served without booting the application, so it cannot depend on anything the
 * application would have to provide.
 */
export function Maintenance({ retryAfter }: MaintenanceProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Back shortly</title>
      </head>
      <body>
        <h1>Back shortly</h1>
        <p>The application is being updated.</p>
        {retryAfter !== undefined && <p>{`Try again in about ${retryAfter} seconds.`}</p>}
      </body>
    </html>
  )
}
