<script setup lang="ts">
import { ref } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { useForm } from '@/lib/form.ts'
import { page } from '@/api.ts'

/**
 * Asking for a reset link.
 *
 * The server answers this one by redirecting to `?sent=1`, which is how it tells a
 * *browser* the mail went out. A client already holds the answer, so the
 * confirmation appears here without a reload — and `onRedirect` is overridden to
 * nothing rather than followed, which would throw away the message it is carrying.
 *
 * `page.sent` is still read: an old `?sent=1` link, or a reload after one, has to
 * arrive as the confirmation and not as a blank form.
 */
const props = page as { error?: string; sent?: boolean }

const sent = ref(props.sent === true)

const form = useForm(
  { email: '' },
  { onRedirect: () => (sent.value = true) }
)
</script>

<template>
  <AuthLayout
    title="Reset your password"
    description="We will email you a link to choose a new one."
  >
    <Alert v-if="sent" class="mb-4">
      <AlertDescription>
        If that address has an account, the link is on its way.
      </AlertDescription>
    </Alert>

    <Alert v-if="props.error" variant="destructive" class="mb-4">
      <AlertDescription>{{ props.error }}</AlertDescription>
    </Alert>

    <form class="grid gap-4" @submit.prevent="form.post('/forgot-password')">
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
      </div>

      <Button type="submit" :disabled="form.processing">
        {{ form.processing ? 'Sending…' : 'Send the link' }}
      </Button>
    </form>

    <p class="text-muted-foreground mt-4 text-center text-sm">
      <a href="/sign-in" class="text-foreground hover:underline">Back to sign in</a>
    </p>
  </AuthLayout>
</template>
