<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { useForm } from '@/lib/form.ts'
import { page } from '@/api.ts'

/**
 * The wall in front of anything that would undo the account's security.
 *
 * A gate, not a destination: the server answers a correct password with
 * `intended(…)` — wherever this person was headed when the wall came up — so the
 * client only has to follow what it is told, and this page needs to know nothing
 * about where that is.
 *
 * `AuthLayout` rather than `AppLayout`, even though somebody is signed in. A
 * sidebar here would offer the navigation this page exists to interrupt.
 */
const props = page as { error?: string }

const form = useForm({ password: '' })
</script>

<template>
  <AuthLayout
    title="Confirm your password"
    description="This is a secure area. Please confirm your password before continuing."
  >
    <Alert v-if="props.error" variant="destructive" class="mb-4">
      <AlertDescription>{{ props.error }}</AlertDescription>
    </Alert>

    <form class="grid gap-4" @submit.prevent="form.post('/confirm-password')">
      <div class="grid gap-2">
        <Label for="password">Password</Label>
        <Input
          id="password"
          v-model="form.data.password"
          type="password"
          autocomplete="current-password"
          required
          autofocus
          :aria-invalid="Boolean(form.errors.password)"
        />
        <p v-if="form.errors.password" class="text-destructive text-sm">
          {{ form.errors.password }}
        </p>
      </div>

      <Button type="submit" :disabled="form.processing">
        {{ form.processing ? 'Checking…' : 'Confirm' }}
      </Button>
    </form>
  </AuthLayout>
</template>
