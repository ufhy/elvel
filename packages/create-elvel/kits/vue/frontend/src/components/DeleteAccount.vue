<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useForm } from '@/lib/form.ts'

/**
 * Closing the account, behind a dialog that asks for the password.
 *
 * A dialog and not a bare button on the page, which is the shape Laravel's own Vue
 * starter kit uses for this — `resources/js/components/DeleteUser.vue`. The reason
 * is the same one that makes the password field here load-bearing: this is the one
 * action on the account that nothing undoes, and it should take two deliberate
 * steps rather than one misplaced click.
 *
 * `DELETE /settings/profile` is the auth kit's own route and controller, unedited.
 * The server asks for the password too — this dialog is not the check, it is how
 * somebody is asked for it.
 *
 * Signing out is the server's business: it answers with a redirect to `/`, and
 * `useForm` follows it as a document load, which is right — the session is gone and
 * the bundle would have nothing left to show.
 */
const open = ref(false)

const form = useForm({ password: '' })

const close = () => {
  open.value = false
  form.reset()
  form.clearErrors()
}
</script>

<template>
  <section class="mt-10 grid max-w-lg gap-3 border-t pt-6">
    <div class="grid gap-1">
      <h2 class="text-destructive text-sm font-medium">Delete this account</h2>
      <p class="text-muted-foreground text-sm">
        Everything goes with it, and it cannot be undone.
      </p>
    </div>

    <div>
      <Button variant="destructive" @click="open = true">Delete account</Button>
    </div>

    <Dialog :open="open" @update:open="(to: boolean) => !to && close()">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this account?</DialogTitle>
          <DialogDescription>
            Everything belonging to it goes too, and none of it comes back. Confirm your
            password to continue.
          </DialogDescription>
        </DialogHeader>

        <form class="grid gap-4" @submit.prevent="form.delete('/settings/profile')">
          <div class="grid gap-2">
            <Label for="delete-password">Password</Label>
            <Input
              id="delete-password"
              v-model="form.data.password"
              type="password"
              autocomplete="current-password"
              :aria-invalid="Boolean(form.errors.password)"
            />
            <p v-if="form.errors.password" class="text-destructive text-sm">
              {{ form.errors.password }}
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="close">Cancel</Button>
            <Button type="submit" variant="destructive" :disabled="form.processing">
              {{ form.processing ? 'Deleting…' : 'Delete account' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </section>
</template>
