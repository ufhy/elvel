<script setup lang="ts">
import { onMounted } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { usePasskey } from '@/composables/usePasskey.ts'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { useForm } from '@/lib/form.ts'

/**
 * Signing in.
 *
 * Nothing is read from the server before this renders. The document is a shell, and
 * a sign-in form needs no data — what it learns comes back from its own submission
 * as a 422, and lands in `form.errors` under the field it belongs to.
 */
const form = useForm({ email: '', password: '' })

/**
 * A passkey signs somebody in, so it lands the same way the form does: a new
 * document, because the session id and the CSRF token have both just changed.
 */
const passkey = usePasskey((to) => window.location.assign(to))

// Offered from the e-mail field, which only works if the call is already in
// flight when the field is focused.
onMounted(() => passkey.offerFromField())
</script>

<template>
  <AuthLayout title="Sign in" description="Enter your email below to sign in.">
    <Alert v-if="passkey.error.value" variant="destructive" class="mb-4">
      <AlertDescription>{{ passkey.error.value }}</AlertDescription>
    </Alert>

    <form class="grid gap-4" @submit.prevent="form.post('/sign-in')">
      <div class="grid gap-2">
        <Label for="email">Email</Label>
        <Input
          id="email"
          v-model="form.data.email"
          type="email"
          autocomplete="username webauthn"
          :aria-invalid="Boolean(form.errors.email)"
        />
        <p v-if="form.errors.email" class="text-destructive text-sm">{{ form.errors.email }}</p>
      </div>

      <div class="grid gap-2">
        <div class="flex items-center justify-between">
          <Label for="password">Password</Label>
          <RouterLink
            to="/auth/forgot-password"
            class="text-muted-foreground text-sm hover:underline"
          >
            Forgot it?
          </RouterLink>
        </div>

        <Input
          id="password"
          v-model="form.data.password"
          type="password"
          autocomplete="current-password"
          :aria-invalid="Boolean(form.errors.password)"
        />
        <p v-if="form.errors.password" class="text-destructive text-sm">
          {{ form.errors.password }}
        </p>
      </div>

      <Button type="submit" :disabled="form.processing">
        {{ form.processing ? 'Signing in…' : 'Sign in' }}
      </Button>
    </form>

    <Button
      variant="outline"
      class="mt-3 w-full"
      :disabled="passkey.working.value"
      @click="passkey.signIn()"
    >
      Use a passkey
    </Button>

    <p class="text-muted-foreground mt-4 text-center text-sm">
      No account yet?
      <RouterLink to="/auth/sign-up" class="text-foreground hover:underline">Create one</RouterLink>.
    </p>
  </AuthLayout>
</template>
