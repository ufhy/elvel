<template>
  <section>
    <h1>No such page</h1>

    <p class="muted">
      The server answered with the application because it cannot know which
      addresses this router owns — so saying "no such page" is the router's job.
    </p>

    <RouterLink to="/dashboard">Back to the dashboard</RouterLink>
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
