import { app, config } from '@elvel/core'
import { Vite } from './tags.ts'

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
    buildDirectory: config<string>('vite.buildDirectory', 'build'),
    // Loud in production, where a missing build is a broken deploy; quiet
    // elsewhere, where it usually means the asset build has not been run yet.
    whenMissing: app().isProduction() ? 'throw' : 'ignore',
    // A hot file in production is always a mistake — see the option's comment.
    trustHotFile: !app().isProduction()
  })

  return instance.tags(entrypoints)
}
