import { AppShell } from '../components/app-shell.tsx'
import { Card, CardHeader } from '../components/ui/card.tsx'

export type DashboardProps = {
  title: string
  name: string
}

export function Dashboard({ title, name }: DashboardProps) {
  return (
    <AppShell title={title} heading={`Welcome back, ${name}`} user={{ name }}>
      <div class="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader
            title="This page"
            description="app/Http/Controllers/DashboardController.ts, and the view beside it."
          />
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            Both are yours. There is nothing to eject from.
          </p>
        </Card>

        <Card>
          <CardHeader title="Your account" description="Name, email, password and sessions." />
          <a class="text-sm text-brand hover:underline" href="/settings/profile">
            Open settings
          </a>
        </Card>
      </div>
    </AppShell>
  )
}
