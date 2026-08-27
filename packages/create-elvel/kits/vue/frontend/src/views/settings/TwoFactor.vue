<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import SettingsLayout from '@/layouts/SettingsLayout.vue'
import { useForm } from '@/lib/form.ts'
import { Skeleton } from '@/components/ui/skeleton'
import { useResource } from '@/composables/useResource.ts'
import { api } from '@/api.ts'

/**
 * Turning two-factor on, and off.
 *
 * Three states, and the middle one is the whole design: **pending** is an enrolment
 * that has been started and not proved. The secret, its URI and ten recovery codes
 * arrive in the payload once — flashed for a single request — and are never shown
 * again. Without the proof step a mistyped setup would lock somebody out of their
 * own account, which is the one failure this feature must not have.
 */
const { data, failed, reload } = useResource(() => api.twoFactor())

const again = { onRedirect: () => void reload() }

const enable = useForm({ password: '' }, again)
const confirm = useForm({ code: '' }, again)
const disable = useForm({ password: '' }, again)
const fresh = useForm({ password: '' }, again)
</script>

<template>
  <SettingsLayout
    title="Two-factor"
    description="A code from your authenticator app, on top of your password."
  >
    <Alert v-if="failed" variant="destructive" class="mb-4">
      <AlertDescription>{{ failed }}</AlertDescription>
    </Alert>

    <!-- Step two: prove the secret was scanned. -->
    <div v-if="data === null && !failed" class="grid max-w-lg gap-3">
      <Skeleton class="h-4 w-64" />
      <Skeleton class="h-9 w-full" />
    </div>

    <div v-else-if="data !== null && data.pending" class="grid max-w-lg gap-4">
      <p class="text-sm">
        Scan this in your authenticator app, or type the secret in by hand, then enter
        the code it shows.
      </p>

      <code class="bg-muted rounded-md px-3 py-2 text-sm break-all">{{ data.pending.secret }}</code>

      <div>
        <p class="mb-1 text-sm font-medium">Recovery codes</p>
        <p class="text-muted-foreground mb-2 text-sm">
          Save these somewhere safe. Each one works once, and this is the only time
          they are shown.
        </p>
        <ul class="bg-muted grid gap-1 rounded-md p-3 font-mono text-sm">
          <li v-for="code in data.pending.codes" :key="code">{{ code }}</li>
        </ul>
      </div>

      <form class="grid gap-2" @submit.prevent="confirm.post('/settings/two-factor/confirm')">
        <Label for="code">Code from the app</Label>
        <Input
          id="code"
          v-model="confirm.data.code"
          inputmode="numeric"
          autocomplete="one-time-code"
          :aria-invalid="Boolean(confirm.errors.code)"
        />
        <p v-if="confirm.errors.code" class="text-destructive text-sm">{{ confirm.errors.code }}</p>

        <div>
          <Button type="submit" :disabled="confirm.processing">
            {{ confirm.processing ? 'Checking…' : 'Turn it on' }}
          </Button>
        </div>
      </form>
    </div>

    <!-- On: offer fresh recovery codes, or turning it off. -->
    <div v-else-if="data !== null && data.enabled" class="grid max-w-lg gap-6">
      <p class="text-sm">Two-factor authentication is on for this account.</p>

      <form class="grid gap-2" @submit.prevent="fresh.post('/settings/two-factor/recovery-codes')">
        <Label for="fresh-password">New recovery codes</Label>
        <p class="text-muted-foreground text-sm">
          Confirm your password to replace the old set. The old codes stop working.
        </p>
        <Input
          id="fresh-password"
          v-model="fresh.data.password"
          type="password"
          autocomplete="current-password"
          :aria-invalid="Boolean(fresh.errors.password)"
        />
        <p v-if="fresh.errors.password" class="text-destructive text-sm">
          {{ fresh.errors.password }}
        </p>

        <div>
          <Button type="submit" variant="outline" :disabled="fresh.processing">Generate</Button>
        </div>
      </form>

      <!-- DELETE on the same address, which is what the controller registers. -->
      <form class="grid gap-2" @submit.prevent="disable.delete('/settings/two-factor')">
        <Label for="disable-password">Turn it off</Label>
        <Input
          id="disable-password"
          v-model="disable.data.password"
          type="password"
          autocomplete="current-password"
          :aria-invalid="Boolean(disable.errors.password)"
        />
        <p v-if="disable.errors.password" class="text-destructive text-sm">
          {{ disable.errors.password }}
        </p>

        <div>
          <Button type="submit" variant="destructive" :disabled="disable.processing">
            Turn off
          </Button>
        </div>
      </form>
    </div>

    <!-- Off: step one. -->
    <form
      v-else-if="data !== null"
      class="grid max-w-lg gap-2"
      @submit.prevent="enable.post('/settings/two-factor')"
    >
      <Label for="enable-password">Confirm your password to begin</Label>
      <Input
        id="enable-password"
        v-model="enable.data.password"
        type="password"
        autocomplete="current-password"
        :aria-invalid="Boolean(enable.errors.password)"
      />
      <p v-if="enable.errors.password" class="text-destructive text-sm">
        {{ enable.errors.password }}
      </p>

      <div>
        <Button type="submit" :disabled="enable.processing">
          {{ enable.processing ? 'Starting…' : 'Set up two-factor' }}
        </Button>
      </div>
    </form>
  </SettingsLayout>
</template>
