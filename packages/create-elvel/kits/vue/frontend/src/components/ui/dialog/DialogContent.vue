<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { DialogContent, DialogPortal, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'
import DialogOverlay from './DialogOverlay.vue'

const props = defineProps<DialogContentProps & { class?: HTMLAttributes['class'] }>()
const emits = defineEmits<DialogContentEmits>()

defineOptions({ inheritAttrs: false })

const forwarded = useForwardPropsEmits(reactiveOmit(props, 'class'), emits)
</script>

<template>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent
      data-slot="dialog-content"
      v-bind="{ ...forwarded, ...$attrs }"
      :class="cn(
        'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg',
        props.class,
      )"
    >
      <slot />
    </DialogContent>
  </DialogPortal>
</template>
