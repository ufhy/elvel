<script setup lang="ts">
import { ref } from 'vue'
import { csrf, currentUser, type User } from './api.ts'

/**
 * The shell: who is signed in, and where the pages appear.
 *
 * No request on boot. The server embedded the user in the document it rendered, so
 * the header is right at first paint — there is no moment where the application is
 * running but does not yet know who is using it.
 */
const user = ref<User | null>(currentUser())
</script>

<template>
  <div class="shell">
    <header v-if="user">
      <strong>{{ user.name || user.email }}</strong>

      <!--
        A form, not a fetch.
        
        Signing out is an auth flow, and in this kit those are pages: the server
        clears the session cookie and redirects. Doing it with `fetch` would mean
        handling the redirect and the stale payload by hand, for no gain — the
        page is leaving anyway.
      -->
      <form method="post" action="/sign-out">
        <input type="hidden" name="_token" :value="csrf()" />
        <button type="submit">Sign out</button>
      </form>
    </header>

    <main>
      <RouterView />
    </main>
  </div>
</template>

<style>
:root {
  --fg: #1c1c1e;
  --muted: #6b6b70;
  --line: #e5e5ea;
  font-family: ui-sans-serif, system-ui, sans-serif;
  color: var(--fg);
}

.shell {
  max-width: 48rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 0.875rem;
  border-bottom: 1px solid var(--line);
  margin-bottom: 1.5rem;
  font-size: 0.9375rem;
}
</style>
