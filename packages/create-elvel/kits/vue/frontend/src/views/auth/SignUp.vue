<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { useForm } from '@/lib/form.ts'

/**
 * Creating an account.
 *
 * Three fields, because three is what the server reads — there is no
 * `password_confirmation` here and adding one would be a field the controller
 * ignores, which is worse than not having it.
 */

const form = useForm({ name: '', email: '', password: '' })
</script>

<template>
  <AuthLayout title="Create an account" description="Enter your details to get started.">
    <form class="grid gap-4" @submit.prevent="form.post('/sign-up')">
      <div class="grid gap-2">
        <Label for="name">Name</Label>
        <Input id="name" v-model="form.data.name" autocomplete="name" required />
        <p v-if="form.errors.name" class="text-destructive text-sm">{{ form.errors.name }}</p>
      </div>

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

      <div class="grid gap-2">
        <Label for="password">Password</Label>
        <Input
          id="password"
          v-model="form.data.password"
          type="password"
          autocomplete="new-password"
          required
          :aria-invalid="Boolean(form.errors.password)"
        />
        <p v-if="form.errors.password" class="text-destructive text-sm">
          {{ form.errors.password }}
        </p>
      </div>

      <Button type="submit" :disabled="form.processing">
        {{ form.processing ? 'Creating…' : 'Create account' }}
      </Button>
    </form>

    <p class="text-muted-foreground mt-4 text-center text-sm">
      Already have an account?
      <a href="/sign-in" class="text-foreground hover:underline">Sign in</a>.
    </p>
  </AuthLayout>
</template>
