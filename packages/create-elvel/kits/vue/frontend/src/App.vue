<script setup lang="ts">
/**
 * The root, and deliberately almost nothing.
 *
 * Each page brings its own layout — `AppLayout` for anything signed in, none at
 * all for a 404 reached from outside — so there is nothing here to render around
 * them. What used to live here (the header, the sign-out form) is in `AppSidebar`
 * and `NavUser`, where the sidebar can collapse it.
 */
</script>

<template>
  <RouterView />
</template>
