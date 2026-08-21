import { csrfField, methodField } from '@elvel/http'
import type { PasskeyRow } from '../../../../app/Http/Controllers/Settings/PasskeyController.ts'
import { Alert } from '../../components/ui/alert.tsx'
import { Button } from '../../components/ui/button.tsx'
import { CardHeader } from '../../components/ui/card.tsx'
import { Input } from '../../components/ui/input.tsx'
import { SettingsLayout } from './nav.tsx'

export type PasskeysProps = {
  title: string
  passkeys: PasskeyRow[]
  removed?: boolean | undefined
  error?: string | undefined
}

/**
 * The keys this account can be opened with.
 *
 * One control here is not a form. Registering a passkey has to ask the *device* to
 * create a key — a private key a server could produce would not be a passkey — so
 * `data-passkey="register"` is what `resources/js/passkeys.ts` listens for.
 * Everything else is ordinary HTML, removal included, and keeps working with
 * JavaScript off.
 */
export function Passkeys({ title, passkeys, removed, error }: PasskeysProps) {
  return (
    <SettingsLayout title={title} current="passkeys">
      <div class="space-y-8">
        <div>
          <CardHeader
            title="Passkeys"
            description="Your fingerprint, face or screen lock, instead of a password."
          />

          <div class="space-y-3">
            <Alert message={removed ? 'That passkey was removed.' : undefined} tone="success" />
            <Alert message={error} tone="error" />

            {/*
              Filled in by the script when the device refuses or the prompt is
              dismissed. `hidden` until then, because there is nothing to say — and
              `hidden` rather than absent so the script has an element to write to.
            */}
            <p
              class="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              data-passkey-error
              hidden
              role="alert"
            />
          </div>
        </div>

        <div class="max-w-xs space-y-4">
          <p class="text-sm text-muted-foreground">
            Your device makes a key it will not hand over, and this site only ever sees the
            signature. Nothing to remember, and nothing to steal from a database.
          </p>

          {/*
            No `<form>`: there is nowhere to post to. The button hands off to
            `navigator.credentials`, and the browser talks to better-auth's own
            endpoint from there.
          */}
          <Input name="passkey-name" label="Name" placeholder="This device" />

          <Button type="button" data={{ passkey: 'register' }}>
            Add a passkey
          </Button>
        </div>

        <div class="space-y-3">
          <CardHeader title="Registered" description="Remove one and that device stops working." />

          {passkeys.length === 0 ? (
            <p class="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul class="divide-y rounded-md border">
              {passkeys.map((passkey) => (
                <li class="flex items-center justify-between gap-4 px-4 py-3">
                  <span class="grid min-w-0 leading-tight">
                    <span class="truncate text-sm font-medium" safe>
                      {passkey.name}
                    </span>
                    <span class="truncate text-xs text-muted-foreground" safe>
                      {[passkey.deviceType, passkey.createdAt?.slice(0, 10)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>

                  <form method="post" action="/settings/passkeys">
                    {csrfField()}
                    {methodField('DELETE')}
                    <input type="hidden" name="id" value={passkey.id} />

                    <Button variant="secondary" size="sm" type="submit">
                      Remove
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </SettingsLayout>
  )
}
