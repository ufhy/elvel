<script setup lang="ts">
import { watch } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useResource } from '@/composables/useResource.ts'
import SettingsLayout from '@/layouts/SettingsLayout.vue'
import { useForm } from '@/lib/form.ts'
import DeleteAccount from '@/components/DeleteAccount.vue'
import { api } from '@/api.ts'

/**
 * Name and email address.
 *
 * Read from `/api/settings/profile` rather than from the document, which is what
 * makes this page survive a client-side navigation: the request belongs to the page
 * that made it, and a payload would have belonged to whichever document happened to
 * load.
 *
 * Changing the address does not change it: better-auth sends a confirmation to the
 * new one first, and until that link is opened the old address is still the
 * account's.
 */
const { data, failed } = useResource(() => api.profile())

const form = useForm({ name: '', email: '' })

// Filled when the answer arrives, not before — the form exists from the first
// render so the template needs no branch around it.
watch(data, (loaded) => {
  if (loaded) {
    form.data.name = loaded.name
    form.data.email = loaded.email
  }
})

const saved = new URLSearchParams(window.location.search).has('saved')
const pending = new URLSearchParams(window.location.search).has('pending')
</script>

<template>
  <SettingsLayout title="Profile" description="Your name and email address.">
    <Alert v-if="saved" class="mb-4">
      <AlertDescription>Saved.</AlertDescription>
    </Alert>

    <Alert v-if="pending" class="mb-4">
      <AlertDescription>
        Check the new address — the change takes effect when you open the link we sent
        there.
      </AlertDescription>
    </Alert>

    <Alert v-if="failed" variant="destructive" class="mb-4">
      <AlertDescription>{{ failed }}</AlertDescription>
    </Alert>

    <div v-if="data === null && !failed" class="grid max-w-lg gap-4">
      <Skeleton class="h-9 w-full" />
      <Skeleton class="h-9 w-full" />
    </div>

    <form
      v-else-if="data !== null"
      class="grid max-w-lg gap-4"
      @submit.prevent="form.patch('/settings/profile')"
    >
      <div class="grid gap-2">
        <Label for="name">Name</Label>
        <Input
          id="name"
          v-model="form.data.name"
          autocomplete="name"
          :aria-invalid="Boolean(form.errors.name)"
        />
        <p v-if="form.errors.name" class="text-destructive text-sm">{{ form.errors.name }}</p>
      </div>

      <div class="grid gap-2">
        <Label for="email">Email</Label>
        <Input
          id="email"
          v-model="form.data.email"
          type="email"
          autocomplete="username"
          :aria-invalid="Boolean(form.errors.email)"
        />
        <p v-if="form.errors.email" class="text-destructive text-sm">{{ form.errors.email }}</p>

        <p v-if="data.emailVerified === false" class="text-muted-foreground text-sm">
          This address is unverified.
          <RouterLink to="/verify-email" class="text-foreground hover:underline">Send the link again</RouterLink>.
        </p>
      </div>

      <div>
        <Button type="submit" :disabled="form.processing">
          {{ form.processing ? 'Saving…' : 'Save' }}
        </Button>
      </div>
    </form>

    <DeleteAccount />
  </SettingsLayout>
</template>
