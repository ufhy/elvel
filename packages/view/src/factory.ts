import type { ViewFactory } from '@elysian/contracts'
import { Edge } from 'edge.js'

export type ViewFactoryOptions = {
  /** Primary views directory, e.g. `resources/views`. */
  path: string
  /** Extra named disks: `{ emails: '.../resources/emails' }` -> `emails::welcome`. */
  disks?: Record<string, string>
  /**
   * Cache compiled templates. Edge's cache is in-memory only (there is no
   * on-disk compiled-view directory like Laravel's `storage/framework/views`),
   * so this is a per-process cache — enable it in production, leave it off
   * locally so template edits show up on reload.
   */
  cache?: boolean
  /** Values available in every template. */
  globals?: Record<string, unknown>
}

/**
 * View factory backed by Edge.js.
 *
 * Edge is the closest thing Node has to Blade — same directive feel
 * (`@if`, `@each`, `@include`, `@component` with named slots), built by the
 * AdonisJS team as a standalone package. We wrap it rather than write a Blade
 * compiler: the compiler is Eloquent-sized work for a solved problem.
 */
export class EdgeViewFactory implements ViewFactory {
  private readonly edge: Edge

  constructor(options: ViewFactoryOptions) {
    this.edge = Edge.create({ cache: options.cache ?? false })
    this.edge.mount(options.path)

    for (const [name, directory] of Object.entries(options.disks ?? {})) {
      this.edge.mount(name, directory)
    }

    for (const [key, value] of Object.entries(options.globals ?? {})) {
      this.edge.global(key, value)
    }
  }

  /**
   * Render a template. Dot notation is accepted so `view('pages.landing')`
   * resolves `resources/views/pages/landing.edge`, matching Laravel.
   */
  render(template: string, data: Record<string, unknown> = {}): Promise<string> {
    return this.edge.render(this.normalize(template), data)
  }

  share(key: string, value: unknown): this {
    this.edge.global(key, value)
    return this
  }

  mount(name: string, directory: string): this {
    this.edge.mount(name, directory)
    return this
  }

  /** Escape hatch for custom tags/plugins — the underlying Edge instance. */
  get engine(): Edge {
    return this.edge
  }

  private normalize(template: string): string {
    const [disk, path] = template.includes('::')
      ? (template.split('::') as [string, string])
      : [undefined, template]

    const normalized = path.replace(/\./g, '/')
    return disk === undefined ? normalized : `${disk}::${normalized}`
  }
}
