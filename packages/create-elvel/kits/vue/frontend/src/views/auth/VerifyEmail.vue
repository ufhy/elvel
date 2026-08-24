<script setup lang="ts">
import { ref } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { csrf, page } from '@/api.ts'
import { useForm } from '@/lib/form.ts'

/**
 * Waiting for the link in the inbox.
 *
 * Nothing to fill in — the only action is asking for another mail — so this posts
 * an empty body. Like `/forgot-password`, the server answers a browser by
 * redirecting to `?sent=1`; a client shows the confirmation where it stands.
 *
 * Signing out is here on purpose. Somebody is signed in but cannot get past this
 * screen, and without a way out the only escape is clearing cookies.
 */
const props = page as { email?: string; sent?: boolean }

const sent = ref(props.sent === true)

const form = useForm({}, { onRedirect: () => (sent.value = true) })
</script>

<template>
  <AuthLayout title="Confirm your address">
    <p class="text-muted-foreground mb-4 text-sm">
      We sent a link to <span class="text-foreground font-medium">{{ props.email }}</span>. Open it
      and this account is verified.
    </p>

    <Alert v-if="sent" class="mb-4">
      <AlertDescription>A fresh link is on its way.</AlertDescription>
    </Alert>

    <Button class="w-full" :disabled="form.processing" @click="form.post('/verify-email/resend')">
      {{ form.processing ? 'Sending…' : 'Send it again' }}
    </Button>

    <form method="post" action="/sign-out" class="mt-4 text-center">
      <input type="hidden" name="_token" :value="csrf()" />
      <button type="submit" class="text-muted-foreground text-sm hover:underline">Sign out</button>
    </form>
  </AuthLayout>
</template>
