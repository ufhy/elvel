<script setup lang="ts">
import { ChevronsUpDownIcon, LogOutIcon, SettingsIcon } from '@lucide/vue'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, useSidebar } from '@/components/ui/sidebar'
import { csrf, currentUser } from '@/api.ts'

/**
 * Who is signed in, and the one control that has to leave the application.
 *
 * The user comes from the document the server rendered, so this is correct at
 * first paint — there is no moment where the application is running and does not
 * yet know who is using it, and no spinner standing in for one.
 */
const user = currentUser()
const { isMobile } = useSidebar()

/** Two letters, because an avatar with no image still has to be something. */
const initials = (name: string, email: string): string => {
  const source = name.trim() === '' ? email : name

  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}
</script>

<template>
  <DropdownMenu v-if="user">
    <DropdownMenuTrigger as-child>
      <SidebarMenuButton size="lg" class="data-[state=open]:bg-sidebar-accent">
        <Avatar class="size-8 rounded-lg">
          <AvatarFallback class="rounded-lg">
            {{ initials(user.name, user.email) }}
          </AvatarFallback>
        </Avatar>

        <div class="grid flex-1 text-left text-sm leading-tight">
          <span class="truncate font-medium">{{ user.name || user.email }}</span>
          <span class="text-muted-foreground truncate text-xs">{{ user.email }}</span>
        </div>

        <ChevronsUpDownIcon class="ml-auto size-4" />
      </SidebarMenuButton>
    </DropdownMenuTrigger>

    <DropdownMenuContent
      class="w-(--reka-dropdown-menu-trigger-width) min-w-56 rounded-lg"
      :side="isMobile ? 'bottom' : 'right'"
      align="end"
      :side-offset="4"
    >
      <DropdownMenuLabel class="p-0 font-normal">
        <div class="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
          <Avatar class="size-8 rounded-lg">
            <AvatarFallback class="rounded-lg">
              {{ initials(user.name, user.email) }}
            </AvatarFallback>
          </Avatar>

          <div class="grid flex-1 text-left text-sm leading-tight">
            <span class="truncate font-medium">{{ user.name || user.email }}</span>
            <span class="text-muted-foreground truncate text-xs">{{ user.email }}</span>
          </div>
        </div>
      </DropdownMenuLabel>

      <DropdownMenuSeparator />

      <DropdownMenuItem as-child>
        <!--
          A document, not a client push.

          The profile page renders the name and address the server put in the
          payload, and a client-side navigation fetches no new payload — it would
          arrive with this page's one and show an empty form.
        -->
        <a href="/settings/profile">
          <SettingsIcon class="size-4" />
          Settings
        </a>
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <!--
        A form, not a fetch.

        Signing out clears an `HttpOnly` cookie, which only a response can do, and
        the page is leaving anyway — so there is nothing for client code to
        coordinate. `_token` is the same CSRF token every write here carries.
      -->
      <form method="post" action="/sign-out">
        <input type="hidden" name="_token" :value="csrf()" />

        <DropdownMenuItem as-child>
          <button type="submit" class="w-full">
            <LogOutIcon class="size-4" />
            Sign out
          </button>
        </DropdownMenuItem>
      </form>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
