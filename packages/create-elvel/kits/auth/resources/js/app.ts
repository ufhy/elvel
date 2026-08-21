/**
 * The application's JavaScript.
 *
 * A server-rendered application needs very little of this — the pages arrive as
 * HTML — so what is here is only what HTML cannot do by itself. Right now that is
 * one thing: a passkey, whose private key never leaves the device and whose
 * signature can only be asked for by script on the page.
 *
 * The stylesheet is a second entry point in `vite.config.ts` rather than an
 * import here, so a page can carry the CSS without waiting for the JavaScript.
 */
import './passkeys.ts'

console.debug('%c⚡ Elvel', 'color: #FF2D20; font-weight: bold')
