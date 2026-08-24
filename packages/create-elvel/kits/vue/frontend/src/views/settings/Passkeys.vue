<script setup lang="ts">
import { ref } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { usePasskey } from '@/composables/usePasskey.ts'
import SettingsLayout from '@/layouts/SettingsLayout.vue'
import { useForm } from '@/lib/form.ts'
import { page } from '@/api.ts'

type Row = { id: string; name: string; createdAt?: string; deviceType?: string }

/**
 * Passkeys on this account.
 *
 * Adding one cannot be a form: the private key never leaves the device and the
 * browser will only produce a signature for script on the page. Removing one is an
 * ordinary request, so it is one.
 */
const props = page as { passkeys?: Row[]; removed?: boolean; error?: string }

const name = ref('')

// A registered passkey has to appear in the list, and the list came from the
// server — so the honest way to show it is to ask again.
const passkey = usePasskey(() => window.location.reload())

const remove = useForm({ id: '' })

/** The id travels in the form, so it is set on the way into the request. */
const removeOne = (id: string) => {
  remove.data.id = id

  return remove.delete('/settings/passkeys')
}

const add = async () => {
  if (await passkey.register(name.value)) window.location.reload()
}

const on = (value?: string) => (value ? new Date(value).toLocaleDateString() : '')
</script>

<template>
  <SettingsLayout title="Passkeys" description="Sign in with your device instead of a password.">
    <Alert v-if="props.removed" class="mb-4">
      <AlertDescription>That passkey was removed.</AlertDescription>
    </Alert>

    <Alert
      v-if="props.error || passkey.error.value"
      variant="destructive"
      class="mb-4"
    >
      <AlertDescription>{{ passkey.error.value || props.error }}</AlertDescription>
    </Alert>

    <ul v-if="props.passkeys?.length" class="mb-6 grid gap-2">
      <li
        v-for="row in props.passkeys"
        :key="row.id"
        class="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
      >
        <span>
          <span class="font-medium">{{ row.name }}</span>
          <span v-if="row.createdAt" class="text-muted-foreground"> — added {{ on(row.createdAt) }}</span>
        </span>

        <Button
          variant="outline"
          size="sm"
          :disabled="remove.processing"
          @click="removeOne(row.id)"
        >
          Remove
        </Button>
      </li>
    </ul>

    <p v-else class="text-muted-foreground mb-6 text-sm">No passkeys yet.</p>

    <div class="grid max-w-lg gap-2">
      <Label for="passkey-name">Name this device</Label>
      <Input id="passkey-name" v-model="name" placeholder="MacBook" />

      <div>
        <Button :disabled="passkey.working.value" @click="add()">
          {{ passkey.working.value ? 'Waiting for your device…' : 'Add a passkey' }}
        </Button>
      </div>
    </div>
  </SettingsLayout>
</template>
