import { user } from '@elvel/auth'
import { LensApplicationServiceProvider, lens, type IncomingEntry } from '@elvel/lens'

/**
 * Who may read Lens, and what it keeps.
 *
 * Both decisions are yours, which is why this file is in your application
 * rather than in the package.
 */
export class LensServiceProvider extends LensApplicationServiceProvider {
  override register(): void {
    this.hideSensitiveRequestDetails()

    const local = this.app.environment() === 'local'

    /**
     * Outside development, keep only what somebody would go looking for.
     *
     * Recording everything in production is how a recorder becomes the largest
     * table in the database. These five are Telescope's list, and the
     * predicates on `IncomingEntry` exist so this line can be written.
     */
    lens().filter((entry: IncomingEntry) => {
      return (
        local ||
        entry.isException() ||
        entry.isFailedRequest() ||
        entry.isFailedJob() ||
        entry.isScheduledTask() ||
        entry.isSlowQuery() ||
        /**
         * The escape hatch, and the reason the monitoring screen exists.
         *
         * Everything above names a *kind* of entry worth keeping. This names a
         * *subject*: add `auth:41` from the dashboard and everything belonging
         * to that account is kept until you remove it again, with no deploy.
         */
        entry.hasMonitoredTag()
      )
    })
  }

  /**
   * Nothing sensitive reaches a row outside development.
   *
   * `cookie` matters most: a session cookie in a table anybody with the
   * dashboard can read is a session anybody with the dashboard can take.
   */
  private hideSensitiveRequestDetails(): void {
    if (this.app.environment() === 'local') return

    lens().hideRequestParameters(['_token'])
    lens().hideRequestHeaders(['cookie', 'x-csrf-token', 'x-xsrf-token'])
  }

  /**
   * Who may read the dashboard.
   *
   * Refuses everyone until you add yourself. Fill in the addresses, or replace
   * the whole body with whatever your application actually uses.
   */
  protected override async authorise(_request: Request): Promise<boolean> {
    /**
     * The playground is a demo nothing outside this machine reaches, so `local`
     * is enough here. It is not enough in general — an application with an empty
     * `HOST` binds every interface — which is why `@elvel/lens` refuses by
     * default and this decision lives in the application rather than the
     * package.
     */
    if (this.app.environment() === 'local') return true

    const signedIn = user()

    if (signedIn === null) return false

    return ([] as string[]).includes(String(signedIn.email))
  }
}
