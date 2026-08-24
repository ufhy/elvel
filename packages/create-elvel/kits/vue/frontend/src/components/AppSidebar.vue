<script setup lang="ts">
import { LayoutGridIcon } from '@lucide/vue'
import { useRoute } from 'vue-router'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from '@/components/ui/sidebar'
import NavUser from '@/components/NavUser.vue'
import { appName } from '@/api.ts'

/**
 * The navigation, and the only place a page's address is written down twice.
 *
 * `isActive` compares against the live route rather than tracking a click, so a
 * deep link — a reload on `/dashboard`, a link somebody pasted — lights up the
 * right item on first paint.
 */
const route = useRoute()

const items = [{ title: 'Dashboard', to: '/dashboard', icon: LayoutGridIcon }]
</script>

<template>
  <Sidebar collapsible="icon" variant="inset">
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" as-child>
            <RouterLink to="/dashboard">
              <div
                class="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg"
              >
                <span class="text-sm font-semibold">E</span>
              </div>

              <div class="grid flex-1 text-left text-sm leading-tight">
                <span class="truncate font-semibold">{{ appName() }}</span>
                <span class="text-muted-foreground truncate text-xs">Elvel</span>
              </div>
            </RouterLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem v-for="item in items" :key="item.to">
            <SidebarMenuButton
              as-child
              :is-active="route.path === item.to"
              :tooltip="item.title"
            >
              <RouterLink :to="item.to">
                <component :is="item.icon" class="size-4" />
                <span>{{ item.title }}</span>
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <NavUser />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  </Sidebar>
</template>
