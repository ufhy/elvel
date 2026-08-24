<script setup lang="ts">
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import AppLayout from '@/layouts/AppLayout.vue'
import { currentUser } from '@/api.ts'

/**
 * The first screen, rendered from the document rather than fetched.
 *
 * `currentUser()` reads what the server embedded, so there is no request here and
 * no spinner. Replace this with your application; the pattern is the point.
 */
const user = currentUser()
</script>

<template>
  <AppLayout title="Dashboard">
    <div class="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Signed in</CardTitle>
          <CardDescription>Read from the document, not fetched.</CardDescription>
        </CardHeader>

        <CardContent class="text-sm">
          <p v-if="user">
            <span class="font-medium">{{ user.email }}</span> — and this page made no
            request to find that out.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deep links work</CardTitle>
          <CardDescription>Every unknown path answers with this document.</CardDescription>
        </CardHeader>

        <CardContent class="text-muted-foreground text-sm">
          Reload on any page under here. The server answers with the same document,
          so the router boots the same application at the same address.
        </CardContent>
      </Card>
    </div>
  </AppLayout>
</template>
