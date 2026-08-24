<script setup lang="ts">
/**
 * The root of the auth bundle, and deliberately nothing.
 *
 * Each screen brings `AuthLayout` itself — one card, centred, no sidebar, because
 * there is nobody signed in to put in one.
 */
</script>

<template>
  <RouterView />
</template>
