<script setup lang="ts">
import { MonitorIcon, MoonIcon, SunIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { type Appearance, useAppearance } from '@/composables/useAppearance.ts'
import SettingsLayout from '@/layouts/SettingsLayout.vue'

/**
 * The one settings page with no server behind it.
 *
 * A theme is the browser's business: nothing about the account changes, so there is
 * nothing to post and nothing to guard. It is remembered in `localStorage`, which
 * means per browser rather than per account — the honest scope for a preference the
 * device itself has an opinion about.
 */
const { appearance, choose } = useAppearance()

const options: Array<{ value: Appearance; label: string; icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: MonitorIcon }
]
</script>

<template>
  <SettingsLayout title="Appearance" description="Remembered in this browser.">
    <div class="flex gap-2">
      <Button
        v-for="option in options"
        :key="option.value"
        :variant="appearance === option.value ? 'default' : 'outline'"
        @click="choose(option.value)"
      >
        <component :is="option.icon" class="size-4" />
        {{ option.label }}
      </Button>
    </div>
  </SettingsLayout>
</template>
