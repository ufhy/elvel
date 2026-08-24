<script setup lang="ts">
import { useRoute } from 'vue-router'
import { Separator } from '@/components/ui/separator'
import AppLayout from '@/layouts/AppLayout.vue'

/**
 * The settings frame — inside the application shell, with its own navigation.
 *
 * Nested rather than a layout of its own: a settings page is still a signed-in
 * page, so it keeps the sidebar and the header above it.
 */
defineProps<{ title: string; description?: string }>()

const route = useRoute()

const items = [
  { title: 'Profile', to: '/settings/profile' },
  { title: 'Password', to: '/settings/password' },
  { title: 'Two-factor', to: '/settings/two-factor' },
  { title: 'Passkeys', to: '/settings/passkeys' },
  { title: 'Security', to: '/settings/security' },
  { title: 'Appearance', to: '/settings/appearance' }
]
</script>

<template>
  <AppLayout title="Settings">
    <div class="flex flex-col gap-6 lg:flex-row">
      <!--
        Client-side navigation, and it is safe because each page fetches its own
        data. This was plain anchors while the pages read a payload out of the
        document: a push carried the previous page's data and rendered empty lists.
      -->
      <nav class="flex w-full flex-col gap-1 lg:w-48">
        <RouterLink
          v-for="item in items"
          :key="item.to"
          :to="item.to"
          class="rounded-md px-3 py-2 text-sm"
          :class="
            route.path === item.to
              ? 'bg-muted font-medium'
              : 'text-muted-foreground hover:bg-muted/60'
          "
        >
          {{ item.title }}
        </RouterLink>
      </nav>

      <Separator orientation="vertical" class="hidden lg:block" />

      <div class="flex-1">
        <div class="mb-6">
          <h2 class="text-lg font-medium">{{ title }}</h2>
          <p v-if="description" class="text-muted-foreground text-sm">{{ description }}</p>
        </div>

        <slot />
      </div>
    </div>
  </AppLayout>
</template>
