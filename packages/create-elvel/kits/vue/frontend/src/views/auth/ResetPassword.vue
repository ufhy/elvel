<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { useForm } from '@/lib/form.ts'

/**
 * Choosing a new password, with the token from the emailed link.
 *
 * The token comes from the address bar, and that is safe here for a reason worth
 * knowing: the server refused this page without one. `Auth/AuthPageController`
 * redirects a tokenless `/reset-password` to `/forgot-password` before any of this
 * loads, so by the time this renders the token is present — and it is the same
 * string the server just saw.
 *
 * Signing in afterwards is deliberately *not* automatic: whoever used the link
 * proved they read the inbox, not that they own the account. So the server sends
 * this one to `/sign-in`, and `useForm` follows it as a document load.
 */
const token = new URLSearchParams(window.location.search).get('token') ?? ''

const form = useForm({ token, password: '', password_confirmation: '' })
</script>

<template>
  <AuthLayout title="Choose a new password">
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
