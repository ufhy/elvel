<script setup lang="ts">
import { watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { usePasswordConfirm } from '@/composables/usePasswordConfirm.ts'
import { useForm } from '@/lib/form.ts'

/**
 * The password wall, where it happens.
 *
 * Mounted once in `AppLayout`, so every screen behind the wall shares one of these
 * — and one confirmation. It never navigates: `onRedirect` is deliberately empty,
 * because the server answers a correct password with `intended(…)` and following
 * that would take somebody away from the screen this exists to keep them on.
 *
 * `views/auth/ConfirmPassword.vue` is still there and is not this. A request that
 * is not JSON — a form posted without JavaScript — is redirected by the server to
 * `passwordConfirmRoute`, and that path needs a page to land on.
 */
const wall = usePasswordConfirm()

const form = useForm(
  { password: '' },
  {
    onRedirect: () => {
      // Deliberately nothing. See above.
    },
    onSuccess: () => {
      form.reset()
      wall.accepted()
    }
  }
)

/**
 * A dismissed dialog rejects what was waiting, and starts clean next time.
 *
 * The old password is cleared with it: leaving a rejected value in the box means
 * the next attempt looks pre-filled and fails for a reason nobody can see.
 */
watch(wall.open, (showing) => {
  if (!showing) {
    form.reset()
    form.clearErrors()
  }
})

const dismiss = () => {
  wall.dismissed()
}
</script>

<template>
  <Dialog :open="wall.open.value" @update:open="(to: boolean) => !to && dismiss()">
    <DialogContent @escape-key-down="dismiss" @pointer-down-outside="dismiss">
      <DialogHeader>
        <DialogTitle>Confirm your password</DialogTitle>
        <DialogDescription>
          This is a secure area. Please confirm your password before continuing.
        </DialogDescription>
      </DialogHeader>

      <form class="grid gap-4" @submit.prevent="form.post('/confirm-password')">
        <div class="grid gap-2">
          <Label for="wall-password">Password</Label>
          <Input
            id="wall-password"
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

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="dismiss">Cancel</Button>
          <Button type="submit" :disabled="form.processing">
            {{ form.processing ? 'Checking…' : 'Confirm' }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
