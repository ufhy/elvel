<script setup lang="ts">
import { ref } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { usePasskey } from '@/composables/usePasskey.ts'
import { useResource } from '@/composables/useResource.ts'
import SettingsLayout from '@/layouts/SettingsLayout.vue'
import { useForm } from '@/lib/form.ts'
import { api } from '@/api.ts'

/**
 * Passkeys on this account.
 *
 * Adding one cannot be a form: the private key never leaves the device, and the
 * browser will only produce a signature for script on the page. Removing one is an
 * ordinary request, so it is one.
 *
 * Both end the same way — ask the list again. The page owns its data now, so there
 * is nothing to reload but the list.
 */
const { data, failed, reload } = useResource(() => api.passkeys())

const name = ref('')

const passkey = usePasskey(() => void reload())
const remove = useForm({ id: '' }, { onRedirect: () => void reload() })

const removeOne = (id: string) => {
  remove.data.id = id

  return remove.delete('/settings/passkeys')
}

const add = async () => {
  if (await passkey.register(name.value)) {
    name.value = ''
    await reload()
  }
}

const on = (value?: string) => (value ? new Date(value).toLocaleDateString() : '')
</script>

<template>
  <SettingsLayout title="Passkeys" description="Sign in with your device instead of a password.">
    <Alert v-if="failed || passkey.error.value" variant="destructive" class="mb-4">
      <AlertDescription>{{ passkey.error.value || failed }}</AlertDescription>
    </Alert>

    <div v-if="data === null && !failed" class="mb-6 grid gap-2">
      <Skeleton class="h-11 w-full" />
    </div>

    <template v-else-if="data !== null">
      <ul v-if="data.passkeys.length" class="mb-6 grid gap-2">
        <li
          v-for="row in data.passkeys"
          :key="row.id"
          class="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
        >
          <span>
            <span class="font-medium">{{ row.name }}</span>
            <span v-if="row.createdAt" class="text-muted-foreground">
              — added {{ on(row.createdAt) }}
            </span>
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
    </template>

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
