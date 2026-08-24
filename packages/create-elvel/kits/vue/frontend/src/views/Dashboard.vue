<script setup lang="ts">
import { currentUser } from '../api.ts'

/**
 * The first screen, rendered from the document rather than fetched.
 *
 * `currentUser()` reads what the server embedded, so there is no request here and
 * no spinner. Replace this with your application; the pattern is the point.
 */
const user = currentUser()
</script>

<template>
  <section>
    <h1>Dashboard</h1>

    <p v-if="user">
      Signed in as <strong>{{ user.email }}</strong> — and this page made no request
      to find that out.
    </p>

    <p class="muted">
      The pages under here are the Vue router's. Reload on any of them: the server
      answers with the same document, so a deep link boots the same application.
    </p>
  </section>
</template>

<style scoped>
h1 {
  font-size: 1.5rem;
  margin: 0 0 1rem;
}

.muted {
  color: var(--muted);
}
</style>
