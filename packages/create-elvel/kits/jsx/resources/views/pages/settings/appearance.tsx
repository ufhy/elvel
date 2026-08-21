import { CardHeader } from '../../components/ui/card.tsx'
import { Icon, type IconName } from '../../components/ui/icon.tsx'
import { SettingsLayout } from './nav.tsx'

export type AppearanceProps = {
  title: string
}

const choices: Array<{ value: string; label: string; icon: IconName }> = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' }
]

/**
 * Light, dark, or whatever the operating system says.
 *
 * The only page in this kit with no form and no route to submit to, because the
 * answer is nobody's business but this browser's: it lives in `localStorage`,
 * `resources/js/app.ts` writes it, and the inline script in `layout.tsx` reads it
 * before the first paint. Storing it on the account instead would mean a
 * round trip to change a colour, and a white flash on every page load until the
 * server said which theme to send.
 *
 * Which means the server cannot know which of the three is selected, so it marks
 * none of them: `app.ts` does that on load. A reader with JavaScript off sees
 * three buttons that do nothing — and a page that follows their system setting,
 * which is what the third button would have chosen anyway.
 */
export function Appearance({ title }: AppearanceProps) {
  return (
    <SettingsLayout title={title} current="appearance">
      <div>
        <CardHeader title="Appearance" description="Choose how this browser renders the site." />

        <div class="inline-flex gap-1 rounded-lg bg-muted p-1">
          {choices.map((choice) => (
            <button
              class="inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm text-muted-foreground transition-colors"
              type="button"
              data-appearance={choice.value}
              aria-pressed="false"
            >
              <Icon name={choice.icon} />
              <span>{choice.label}</span>
            </button>
          ))}
        </div>
      </div>
    </SettingsLayout>
  )
}
