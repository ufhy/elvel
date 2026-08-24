import { createApp } from 'vue'
import App from './App.vue'
import { applyStoredAppearance } from './composables/useAppearance.ts'
import { router } from './router.ts'
import './style.css'

// Before mounting, so the theme is on the first thing rendered rather than applied
// to something already on screen.
applyStoredAppearance()

createApp(App).use(router).mount('#app')
