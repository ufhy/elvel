import type { Children } from '@kitajs/html'
import { AppHeader, type Crumb } from './app-header.tsx'
import { AppSidebar } from './app-sidebar.tsx'
import { Layout } from './layout.tsx'

/**
 * The shell every signed-in page shares: a sidebar, a header, and the page.
 *
 * A page passes a breadcrumb trail rather than a heading, which is the split
 * Laravel's kits arrived at too: the trail says where the page sits and belongs
 * to the shell, while the heading is content and belongs to the page — the
 * settings pages each render their own, under one shared "Settings" title.
 */
export type AppShellProps = {
  title: string
  crumbs?: Crumb[]
  children?: Children
}

export function AppShell({ title, crumbs = [], children }: AppShellProps) {
  return (
    <Layout title={title}>
      <div class="flex min-h-dvh">
        <AppSidebar />

        <div class="flex min-w-0 flex-1 flex-col">
          <AppHeader crumbs={crumbs} />

          <main class="flex min-w-0 flex-1 flex-col p-4">{children}</main>
        </div>
      </div>
    </Layout>
  )
}
