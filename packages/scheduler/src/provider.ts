import { ServiceProvider } from '@elysian/core'
import { ScheduleListCommand } from './console/schedule-list.ts'
import { ScheduleRunCommand } from './console/schedule-run.ts'
import { ScheduleTestCommand } from './console/schedule-test.ts'
import { ScheduleWorkCommand } from './console/schedule-work.ts'
import { Schedule } from './schedule.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    schedule: Schedule
  }
}

/**
 * Binds the schedule and registers the commands that drive it.
 *
 * Entries are registered by the application, in a provider's `boot()`, rather than
 * discovered: a schedule is a handful of lines that belong together and want to be
 * read in one place — Laravel moved the same way when it replaced the console
 * kernel with `withSchedule()`.
 *
 * Nothing runs on its own. Either a crontab calls `schedule:run` every minute, or
 * a long-lived process runs `schedule:work`.
 */
export class ScheduleServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('schedule', (app) => {
      const schedule = new Schedule(app)
      const zone = this.config<string | undefined>('app.timezone', undefined)

      // One zone for the whole schedule, so "daily at 3am" means the same thing
      // to every entry unless one says otherwise.
      if (zone) schedule.useTimezone(zone)

      return schedule
    })
  }

  override boot(): void {
    if (this.app.bound('artisan')) {
      this.app
        .make('artisan')
        .register(ScheduleRunCommand, ScheduleListCommand, ScheduleWorkCommand, ScheduleTestCommand)
    }
  }
}
