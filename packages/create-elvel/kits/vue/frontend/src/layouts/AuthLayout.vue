<script setup lang="ts">
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { appName } from '@/api.ts'

/**
 * The frame every auth screen sits in — one card, centred, nothing else.
 *
 * No sidebar and no user menu, because there is nobody signed in yet. `AppLayout`
 * is the other half of that pair.
 */
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <div class="bg-muted/40 flex min-h-svh flex-col items-center justify-center gap-6 p-6">
    <RouterLink to="/" class="flex items-center gap-2 font-medium">
      <div
        class="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg"
      >
        <span class="text-sm font-semibold">E</span>
      </div>
      {{ appName() }}
    </RouterLink>

    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{{ title }}</CardTitle>
        <CardDescription v-if="description">{{ description }}</CardDescription>
      </CardHeader>

      <CardContent>
        <slot />
      </CardContent>
    </Card>
  </div>
</template>
