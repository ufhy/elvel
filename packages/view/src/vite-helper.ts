import { app, config } from '@elysian/core'
import { Vite } from './vite.ts'

let instance: Vite | undefined

/**
 * The tags for a Vite entry point — `{vite('resources/js/app.ts')}` in a layout.
 *
 * Memoised, because the manifest cannot change while the process runs and the
 * alternative is reading a file on every render.
 */
export function vite(entrypoints: string | string[]): string {
  instance ??= new Vite({
    publicPath: app().basePath('public'),
    buildDirectory: config<string>('vite.buildDirectory', 'build')
  })

  return instance.tags(entrypoints)
}
