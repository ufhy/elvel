import { AppShell } from '../components/app-shell.tsx'
import { PlaceholderPattern } from '../components/ui/placeholder-pattern.tsx'

export type DashboardProps = {
  title: string
  name: string
}

/**
 * The page you land on after signing in.
 *
 * Four hatched boxes and nothing else, which is Laravel's answer and the right
 * one: an empty dashboard that looks *deliberately* empty invites you to put
 * something there, where three cards of filler text read as the kit's opinion
 * about what belongs on your page.
 */
export function Dashboard({ title }: DashboardProps) {
  return (
    <AppShell title={title} crumbs={[{ label: 'Dashboard' }]}>
      <div class="flex flex-1 flex-col gap-4">
        <div class="grid auto-rows-min gap-4 md:grid-cols-3">
          {['one', 'two', 'three'].map((slot) => (
            <div class="relative aspect-video overflow-hidden rounded-xl border">
              <PlaceholderPattern id={`dashboard-${slot}`} class="absolute inset-0 size-full" />
            </div>
          ))}
        </div>

        <div class="relative min-h-96 flex-1 overflow-hidden rounded-xl border">
          <PlaceholderPattern id="dashboard-main" class="absolute inset-0 size-full" />
        </div>
      </div>
    </AppShell>
  )
}
