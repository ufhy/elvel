<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { useForm } from '@/lib/form.ts'

/**
 * Choosing a new password, with the token from the emailed link.
 *
 * The token comes from the address bar, and nothing before this checks it. There
 * is one view route — `routes/view.ts` — and it answers every address under the
 * prefix with the same shell, so `/auth/reset-password` renders whether a token is
 * there or not. Measured: `200` and the shell either way.
 *
 * That is fine, and the reason is where the check actually is: the token is proof,
 * and proof is verified by whoever acts on it. `POST /reset-password` hands it to
 * better-auth, which answers `INVALID_TOKEN` for a missing or spent one, and the
 * form shows "That link has expired. Ask for another." A guard on the page would
 * only have moved the same refusal earlier, and this kit has no page-level guards
 * to move it to.
 *
 * Signing in afterwards is deliberately *not* automatic: whoever used the link
 * proved they read the inbox, not that they own the account. So the server sends
 * this one to `auth.redirectGuestsTo`, and `useForm` follows it as a document load.
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
          :aria-invalid="Boolean(form.errors.password_confirmation)"
        />
        <p v-if="form.errors.password_confirmation" class="text-destructive text-sm">
          {{ form.errors.password_confirmation }}
        </p>
      </div>

      <Button type="submit" :disabled="form.processing">
        {{ form.processing ? 'Saving…' : 'Set the password' }}
      </Button>
    </form>
  </AuthLayout>
</template>
