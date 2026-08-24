<script setup lang="ts">
import { ref } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { useForm } from '@/lib/form.ts'

/**
 * The second factor, with the way out when the phone is not in the room.
 *
 * **Two forms, two `useForm`s**, because they are two endpoints: a TOTP code goes
 * to `/two-factor-challenge` and a recovery code to `…/recovery`. Telling them
 * apart by length would be a rule that breaks the first time either format
 * changes, and sharing one form's state would light up the wrong field's error.
 *
 * Each recovery code works once — better-auth deletes it as it accepts it.
 */

const recovering = ref(false)

const totp = useForm({ code: '' })
const recovery = useForm({ code: '' })
</script>

<template>
  <AuthLayout
    title="Two-factor authentication"
    :description="
      recovering
        ? 'Use one of the recovery codes you saved when you turned this on.'
        : 'Enter the six-digit code from your authenticator app.'
    "
  >
    <form
      v-if="!recovering"
      class="grid gap-4"
      @submit.prevent="totp.post('/two-factor-challenge')"
    >
      <div class="grid gap-2">
        <Label for="code">Code</Label>
        <Input
          id="code"
          v-model="totp.data.code"
          inputmode="numeric"
          autocomplete="one-time-code"
          required
          autofocus
          :aria-invalid="Boolean(totp.errors.code)"
        />
        <p v-if="totp.errors.code" class="text-destructive text-sm">{{ totp.errors.code }}</p>
      </div>

      <Button type="submit" :disabled="totp.processing">
        {{ totp.processing ? 'Checking…' : 'Continue' }}
      </Button>
    </form>

    <form v-else class="grid gap-4" @submit.prevent="recovery.post('/two-factor-challenge/recovery')">
      <div class="grid gap-2">
        <Label for="recovery-code">Recovery code</Label>
        <Input
          id="recovery-code"
          v-model="recovery.data.code"
          autocomplete="one-time-code"
          required
          autofocus
          :aria-invalid="Boolean(recovery.errors.code)"
        />
        <p v-if="recovery.errors.code" class="text-destructive text-sm">
          {{ recovery.errors.code }}
        </p>
      </div>

      <Button type="submit" :disabled="recovery.processing">
        {{ recovery.processing ? 'Checking…' : 'Use a recovery code' }}
      </Button>
    </form>

    <p class="text-muted-foreground mt-4 text-center text-sm">
      <button type="button" class="hover:underline" @click="recovering = !recovering">
        {{ recovering ? 'Use your authenticator app' : 'Lost your phone?' }}
      </button>
    </p>
  </AuthLayout>
</template>
