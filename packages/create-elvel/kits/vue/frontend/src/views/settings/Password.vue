<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import SettingsLayout from '@/layouts/SettingsLayout.vue'
import { useForm } from '@/lib/form.ts'
import { page } from '@/api.ts'

/**
 * Changing the password — which signs every other browser out.
 *
 * `revokeOtherSessions` is on, because a password change is usually a response to
 * somebody else having had access. That also makes this the one settings form that
 * cannot stay client-side: the answer carries fresh cookies, so a new document has
 * to arrive. `useForm` does that by default.
 */
const props = page as { saved?: boolean; error?: string }

const form = useForm({ current: '', password: '', password_confirmation: '' })
</script>

<template>
  <SettingsLayout
    title="Password"
    description="Changing it signs out every other browser you are signed in on."
  >
    <Alert v-if="props.saved" class="mb-4">
      <AlertDescription>Saved. Every other session has been signed out.</AlertDescription>
    </Alert>

    <Alert v-if="props.error" variant="destructive" class="mb-4">
      <AlertDescription>{{ props.error }}</AlertDescription>
    </Alert>

    <form class="grid max-w-lg gap-4" @submit.prevent="form.put('/settings/password')">
      <div class="grid gap-2">
        <Label for="current">Current password</Label>
        <Input
          id="current"
          v-model="form.data.current"
          type="password"
          autocomplete="current-password"
          required
        />
      </div>

      <div class="grid gap-2">
        <Label for="password">New password</Label>
        <Input
          id="password"
          v-model="form.data.password"
          type="password"
          autocomplete="new-password"
          required
          :aria-invalid="Boolean(form.errors.password)"
        />
        <p v-if="form.errors.password" class="text-destructive text-sm">
          {{ form.errors.password }}
        </p>
      </div>

      <div class="grid gap-2">
        <Label for="password_confirmation">Confirm it</Label>
        <Input
          id="password_confirmation"
          v-model="form.data.password_confirmation"
          type="password"
          autocomplete="new-password"
          required
        />
      </div>

      <div>
        <Button type="submit" :disabled="form.processing">
          {{ form.processing ? 'Saving…' : 'Change password' }}
        </Button>
      </div>
    </form>
  </SettingsLayout>
</template>
