<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import SettingsLayout from '@/layouts/SettingsLayout.vue'
import { useForm } from '@/lib/form.ts'
import { page } from '@/api.ts'

/**
 * Name and email address.
 *
 * Changing the address does not change it: better-auth sends a confirmation to the
 * new one first, and `pending` is how the server says so. Until that link is
 * opened, the old address is still the account's.
 */
const props = page as {
  name?: string
  email?: string
  emailVerified?: boolean
  pending?: boolean
  saved?: boolean
  error?: string
}

const form = useForm({ name: props.name ?? '', email: props.email ?? '' })
</script>

<template>
  <SettingsLayout title="Profile" description="Your name and email address.">
    <Alert v-if="props.saved" class="mb-4">
      <AlertDescription>Saved.</AlertDescription>
    </Alert>

    <Alert v-if="props.pending" class="mb-4">
      <AlertDescription>
        Check the new address — the change takes effect when you open the link we
        sent there.
      </AlertDescription>
    </Alert>

    <Alert v-if="props.error" variant="destructive" class="mb-4">
      <AlertDescription>{{ props.error }}</AlertDescription>
    </Alert>

    <form class="grid max-w-lg gap-4" @submit.prevent="form.patch('/settings/profile')">
      <div class="grid gap-2">
        <Label for="name">Name</Label>
        <Input id="name" v-model="form.data.name" autocomplete="name" required />
        <p v-if="form.errors.name" class="text-destructive text-sm">{{ form.errors.name }}</p>
      </div>

      <div class="grid gap-2">
        <Label for="email">Email</Label>
        <Input
          id="email"
          v-model="form.data.email"
          type="email"
          autocomplete="username"
          required
          :aria-invalid="Boolean(form.errors.email)"
        />
        <p v-if="form.errors.email" class="text-destructive text-sm">{{ form.errors.email }}</p>

        <p v-if="props.emailVerified === false" class="text-muted-foreground text-sm">
          This address is unverified.
          <a href="/verify-email" class="text-foreground hover:underline">Send the link again</a>.
        </p>
      </div>

      <div>
        <Button type="submit" :disabled="form.processing">
          {{ form.processing ? 'Saving…' : 'Save' }}
        </Button>
      </div>
    </form>
  </SettingsLayout>
</template>
