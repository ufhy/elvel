<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import SettingsLayout from '@/layouts/SettingsLayout.vue'
import { useForm } from '@/lib/form.ts'
import { page } from '@/api.ts'

type Session = {
  id: string
  current: boolean
  createdAt?: string
  expiresAt?: string
  userAgent?: string
  ipAddress?: string
}

/**
 * Where this account is signed in, and how to cut any of it off.
 *
 * Behind `password.confirm` on the server: reading this list and revoking from it
 * is the one place a borrowed unlocked browser does real damage.
 */
const props = page as { sessions?: Session[]; revoked?: boolean; error?: string }

const revoke = useForm({ id: '' })
const others = useForm({})

/** The id travels in the form, so it is set on the way into the request. */
const revokeOne = (id: string) => {
  revoke.data.id = id

  return revoke.post('/settings/security/revoke')
}

/**
 * The user agent, shortened to something a person can act on.
 *
 * A full UA string is unreadable and the point of the list is recognising your own
 * devices. Not a parser — a browser name and a platform is enough to say "that one
 * is not mine".
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
    <Alert v-if="props.revoked" class="mb-4">
      <AlertDescription>Signed out.</AlertDescription>
    </Alert>

    <Alert v-if="props.error" variant="destructive" class="mb-4">
      <AlertDescription>{{ props.error }}</AlertDescription>
    </Alert>

    <ul class="mb-6 grid gap-2">
      <li
        v-for="session in props.sessions ?? []"
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

    <Button variant="outline" :disabled="others.processing" @click="others.post('/settings/security/revoke-others')">
      Sign out every other browser
    </Button>
  </SettingsLayout>
</template>
