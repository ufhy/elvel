<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { useForm } from '@/lib/form.ts'

/**
 * The wall, for the one caller that cannot be shown a dialog.
 *
 * Inside the application this is a dialog — `components/PasswordConfirmDialog.vue`
 * — because the client catches the `423` itself and nobody needs to leave the
 * screen. This page is the other way in: a request that is not JSON is redirected
 * by the server to `passwordConfirmRoute`, and a redirect has to land somewhere.
 *
 * So it follows what the server says. `intended(…)` is all there is to go on here,
 * and it is right for this path: the server was asked for a document, so what it
 * remembered is a document.
 *
 * `AuthLayout` rather than `AppLayout`, even though somebody is signed in. A
 * sidebar here would offer the navigation this page exists to interrupt.
 */

const form = useForm({ password: '' })
</script>

<template>
  <AuthLayout
    title="Confirm your password"
    description="This is a secure area. Please confirm your password before continuing."
  >
    <form class="grid gap-4" @submit.prevent="form.post('/confirm-password')">
      <div class="grid gap-2">
        <Label for="password">Password</Label>
        <Input
          id="password"
          v-model="form.data.password"
          type="password"
          autocomplete="current-password"
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
