<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useResource } from '@/composables/useResource.ts'
import SettingsLayout from '@/layouts/SettingsLayout.vue'
import { useForm } from '@/lib/form.ts'
import { api } from '@/api.ts'

/**
 * Where this account is signed in, and how to cut any of it off.
 *
 * Behind `password.confirm` twice over: on the page, so a borrowed unlocked browser
 * cannot read the list, and on `/api/settings/sessions`, because that is where the
 * list actually is. Guarding the page alone would be guarding the door and leaving
 * the window.
 */
const { data, failed, reload } = useResource(() => api.sessions())

/**
 * Revoking reloads the list rather than reloading the page.
 *
 * This is the payoff of a page that fetches its own data: the answer changed the
 * thing this page is showing, so asking again is both the simplest and the only
 * version that cannot disagree with the server.
 */
const revoke = useForm({ id: '' }, { onRedirect: () => void reload() })
const others = useForm({}, { onRedirect: () => void reload() })

const revokeOne = (id: string) => {
  revoke.data.id = id

  return revoke.post('/settings/security/revoke')
}

/**
 * The user agent, shortened to something a person can act on.
 *
 * Not a parser — a browser name and a platform is enough to say "that one is not
 * mine", which is the only question this list exists to answer.
 */
const describe = (agent?: string): string => {
  if (!agent) return 'Unknown browser'

  const browser = /Edg/.test(agent)
    ? 'Edge'
    : /Chrome/.test(agent)
      ? 'Chrome'
      : /Safari/.test(agent)
        ? 'Safari'
        : /Firefox/.test(agent)
          ? 'Firefox'
          : 'Browser'

  const platform = /iPhone|iPad/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Mac OS X/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : ''

  return platform === '' ? browser : `${browser} on ${platform}`
}

const on = (value?: string) => (value ? new Date(value).toLocaleString() : '')
</script>

<template>
  <SettingsLayout title="Security" description="Every browser this account is signed in on.">
    <Alert v-if="failed" variant="destructive" class="mb-4">
      <AlertDescription>{{ failed }}</AlertDescription>
    </Alert>

    <div v-if="data === null && !failed" class="mb-6 grid gap-2">
      <Skeleton class="h-14 w-full" />
      <Skeleton class="h-14 w-full" />
    </div>

    <ul v-else-if="data !== null" class="mb-6 grid gap-2">
      <li
        v-for="session in data.sessions"
        :key="session.id"
        class="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
      >
        <span class="grid">
          <span class="flex items-center gap-2 font-medium">
            {{ describe(session.userAgent) }}
            <Badge v-if="session.current" variant="secondary">This browser</Badge>
          </span>
          <span class="text-muted-foreground text-xs">
            {{ session.ipAddress ?? 'Unknown address' }}
            <template v-if="session.createdAt"> — signed in {{ on(session.createdAt) }}</template>
          </span>
        </span>

        <Button
          v-if="!session.current"
          variant="outline"
          size="sm"
          :disabled="revoke.processing"
          @click="revokeOne(session.id)"
        >
          Sign out
        </Button>
      </li>
    </ul>

    <Button
      variant="outline"
      :disabled="others.processing"
      @click="others.post('/settings/security/revoke-others')"
    >
      Sign out every other browser
    </Button>
  </SettingsLayout>
</template>
