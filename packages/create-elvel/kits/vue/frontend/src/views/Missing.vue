<script setup lang="ts">
import { Button } from '@/components/ui/button'

/**
 * The client's own 404.
 *
 * The server answers every unknown path with the document, because it cannot know
 * which paths this router owns. So the router has to be the one to say "no such
 * page", and it needs a page to say it with.
 */
</script>

<template>
  <div class="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
    <p class="text-muted-foreground text-sm font-medium">404</p>
    <h1 class="text-2xl font-semibold tracking-tight">No such page</h1>

    <p class="text-muted-foreground max-w-sm text-sm">
      The server answered with the application, and the router found nothing at this
      address.
    </p>

    <Button as-child variant="outline">
      <RouterLink to="/dashboard">Back to the dashboard</RouterLink>
    </Button>
  </div>
</template>
