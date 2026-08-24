<script setup lang="ts">
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import AppSidebar from '@/components/AppSidebar.vue'

/**
 * The frame every signed-in page sits in.
 *
 * A layout rather than something `App.vue` always renders, because not every page
 * wants it — a sign-in screen has no sidebar, and neither does a 404 reached from
 * outside. Routes name the layout they belong to.
 */
defineProps<{ title?: string }>()
</script>

<template>
  <SidebarProvider>
    <AppSidebar />

    <SidebarInset>
      <header
        class="flex h-16 shrink-0 items-center gap-2 border-b px-4 transition-[width,height] ease-linear"
      >
        <SidebarTrigger class="-ml-1" />
        <Separator orientation="vertical" class="mr-2 h-4" />
        <h1 v-if="title" class="text-base font-medium">{{ title }}</h1>
      </header>

      <div class="flex flex-1 flex-col gap-4 p-4">
        <slot />
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
