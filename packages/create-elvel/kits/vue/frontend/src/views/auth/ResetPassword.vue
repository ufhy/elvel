<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { useForm } from '@/lib/form.ts'
import { page } from '@/api.ts'

/**
 * Choosing a new password, with the token from the emailed link.
 *
 * The token comes from the server rather than from `location.search`. Same value,
 * but the server has already been asked for this page and can refuse a link that
 * is missing or expired — reading the URL here would mean posting a token the
 * server never acknowledged.
 *
 * Signing in afterwards is deliberately *not* automatic: whoever used the link
 * proved they read the inbox, not that they own the account. So the server sends
 * this one to `/sign-in`, and `useForm` follows it as a document load.
 */
const props = page as { token?: string; error?: string }

const form = useForm({
  token: props.token ?? '',
  password: '',
  password_confirmation: ''
})
</script>

<template>
  <AuthLayout title="Choose a new password">
    <Alert v-if="props.error" variant="destructive" class="mb-4">
      <AlertDescription>{{ props.error }}</AlertDescription>
    </Alert>

    <form class="grid gap-4" @submit.prevent="form.post('/reset-password')">
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

      <Button type="submit" :disabled="form.processing">
        {{ form.processing ? 'Saving…' : 'Set the password' }}
      </Button>
    </form>
  </AuthLayout>
</template>
